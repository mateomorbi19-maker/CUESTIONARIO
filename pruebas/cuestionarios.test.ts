import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buscarPorToken,
  consumoDe,
  contarCreadosDesde,
  crearCuestionario,
  ErrorCuestionario,
  estaProcesando,
  fallarProceso,
  guardarEstado,
  registradorDeLlamadas,
  terminarProceso,
  tomarParaProcesar,
} from '../lib/cuestionarios'
import { db } from '../lib/db'

// Base PGlite descartable. La configuración se lee recién en la primera consulta, y cada
// archivo de prueba corre en su propio proceso, así que no toca data/ ni otras pruebas.
process.env.DIR_DATOS = mkdtempSync(join(tmpdir(), 'cuestionario-prueba-'))
delete process.env.DATABASE_URL

const es409 = (err: unknown) => {
  assert.ok(err instanceof ErrorCuestionario)
  assert.equal(err.estadoHttp, 409)
  return true
}

describe('cuestionarios en la base', () => {
  it('se crea con el estado inicial y se encuentra solo con su token', async () => {
    const { cuestionario, token } = await crearCuestionario('  Clínica Norte ', 'dueno@clinica.com')
    assert.match(cuestionario.id, /^CUE-[2-9A-Z]{8}$/)
    assert.equal(cuestionario.negocio, 'Clínica Norte')
    assert.equal(cuestionario.estado.etapa, 'triage')
    assert.equal(cuestionario.procesandoDesde, null)
    assert.ok(token.length >= 30)

    const encontrado = await buscarPorToken(token)
    assert.equal(encontrado?.id, cuestionario.id)
    assert.equal(await buscarPorToken('token-inventado'), null)
    assert.ok((await contarCreadosDesde(new Date(Date.now() - 60_000))) >= 1)
  })

  it('no guarda el token en la base, solo su hash', async () => {
    const { token } = await crearCuestionario('Rotisería', 'r@r.com')
    const base = await db()
    const { rows } = await base.consulta<{ n: number }>('SELECT count(*)::int AS n FROM cuestionarios WHERE token_sha256 = $1', [token])
    assert.equal(rows[0].n, 0)
  })

  it('rechaza datos incompletos', async () => {
    await assert.rejects(crearCuestionario('   ', 'a@b.com'), ErrorCuestionario)
    await assert.rejects(crearCuestionario('Negocio', 'sin-arroba'), ErrorCuestionario)
  })

  it('una escritura con una versión vieja pierde en vez de pisar', async () => {
    const { cuestionario } = await crearCuestionario('Gimnasio', 'g@g.com')
    const guardado = await guardarEstado(cuestionario, { ...cuestionario.estado, negocio: 'Gimnasio del barrio' })
    assert.equal(guardado.version, cuestionario.version + 1)
    await assert.rejects(guardarEstado(cuestionario, cuestionario.estado), es409)
  })
})

describe('candado de procesamiento', () => {
  it('toma, bloquea otras escrituras, termina y libera', async () => {
    const { cuestionario } = await crearCuestionario('Tapicería Norte', 'dueno@tapicerianorte.com')
    const entrada = { tipo: 'respuesta' as const, texto: 'pagó la seña' }

    const tomado = await tomarParaProcesar(cuestionario, entrada)
    assert.ok(estaProcesando(tomado))
    assert.deepEqual(tomado.entradaPendiente, entrada)
    await assert.rejects(tomarParaProcesar(tomado, entrada), es409)
    await assert.rejects(guardarEstado(tomado, tomado.estado), es409)

    const nuevo = { ...tomado.estado, negocio: 'Tapicería Norte' }
    const terminado = await terminarProceso(tomado, nuevo)
    assert.equal(terminado.version, tomado.version + 1)
    assert.equal(terminado.procesandoDesde, null)
    assert.equal(terminado.entradaPendiente, null)
    assert.equal(terminado.estado.negocio, 'Tapicería Norte')
  })

  it('un fallo libera el candado y deja el error y la entrada para reintentar', async () => {
    const { cuestionario, token } = await crearCuestionario('Cerrajería', 'c@c.com')
    const entrada = { tipo: 'confirmar' as const }
    const tomado = await tomarParaProcesar(cuestionario, entrada)
    await fallarProceso(tomado.id, 'Hubo un problema.')

    const despues = (await buscarPorToken(token))!
    assert.equal(estaProcesando(despues), false)
    assert.equal(despues.ultimoError, 'Hubo un problema.')
    assert.deepEqual(despues.entradaPendiente, entrada)
    // Reintentar con la misma versión funciona: el fallo no cambió el estado.
    const otraVez = await tomarParaProcesar(despues, entrada)
    assert.equal(otraVez.ultimoError, null)
  })

  it('un candado vencido (servidor reiniciado) se puede volver a tomar', async () => {
    const { cuestionario, token } = await crearCuestionario('Inmobiliaria', 'i@i.com')
    await tomarParaProcesar(cuestionario, { tipo: 'confirmar' })
    const base = await db()
    await base.consulta("UPDATE cuestionarios SET procesando_desde = now() - interval '20 minutes' WHERE id = $1", [cuestionario.id])

    const vencido = (await buscarPorToken(token))!
    assert.equal(estaProcesando(vencido), false)
    const retomado = await tomarParaProcesar(vencido, { tipo: 'confirmar' })
    assert.ok(estaProcesando(retomado))
  })
})

describe('registro de llamadas', () => {
  it('guarda cada llamada con su caché y la devuelve para calcular el costo', async () => {
    const { cuestionario } = await crearCuestionario('Agencia', 'a@a.com')
    await registradorDeLlamadas(cuestionario.id)({
      paso: 'evaluar_triage',
      modelo: 'claude-opus-5',
      stopReason: 'end_turn',
      tokensEntrada: 120,
      tokensSalida: 40,
      tokensCacheEscritos: 5000,
      tokensCacheLeidos: 0,
      cache: '5m',
      duracionMs: 900,
      error: null,
    })
    assert.deepEqual(await consumoDe(cuestionario.id), [
      { modelo: 'claude-opus-5', cache: '5m', tokensEntrada: 120, tokensSalida: 40, tokensCacheEscritos: 5000, tokensCacheLeidos: 0 },
    ])
  })
})
