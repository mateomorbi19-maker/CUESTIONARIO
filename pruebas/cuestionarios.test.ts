import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buscarPorToken, crearCuestionario, ErrorCuestionario, guardarEstado, registradorDeLlamadas } from '../lib/cuestionarios'
import { db } from '../lib/db'

// Base PGlite descartable. La configuración se lee recién en la primera consulta, y cada
// archivo de prueba corre en su propio proceso, así que no toca data/ ni otras pruebas.
process.env.DIR_DATOS = mkdtempSync(join(tmpdir(), 'cuestionario-prueba-'))
delete process.env.DATABASE_URL

describe('cuestionarios en la base', () => {
  it('se crea con el estado inicial y se encuentra solo con su token', async () => {
    const { cuestionario, token } = await crearCuestionario('  Clínica Norte ', 'dueno@clinica.com')
    assert.match(cuestionario.id, /^CUE-[2-9A-Z]{8}$/)
    assert.equal(cuestionario.negocio, 'Clínica Norte')
    assert.equal(cuestionario.estado.etapa, 'triage')
    assert.ok(token.length >= 30)

    const encontrado = await buscarPorToken(token)
    assert.equal(encontrado?.id, cuestionario.id)
    assert.equal(await buscarPorToken('token-inventado'), null)
  })

  it('no guarda el token en la base, solo su hash', async () => {
    const { token } = await crearCuestionario('Rotisería', 'r@r.com')
    const base = await db()
    const { rows } = await base.consulta<{ n: number }>(
      'SELECT count(*)::int AS n FROM cuestionarios WHERE token_sha256 = $1',
      [token],
    )
    assert.equal(rows[0].n, 0)
  })

  it('rechaza datos incompletos', async () => {
    await assert.rejects(crearCuestionario('   ', 'a@b.com'), ErrorCuestionario)
    await assert.rejects(crearCuestionario('Negocio', 'sin-arroba'), ErrorCuestionario)
  })

  it('una escritura con una versión vieja pierde en vez de pisar', async () => {
    const { cuestionario } = await crearCuestionario('Gimnasio', 'g@g.com')
    const avanzado = { ...cuestionario.estado, negocio: 'Gimnasio del barrio' }

    const guardado = await guardarEstado(cuestionario, avanzado)
    assert.equal(guardado.version, cuestionario.version + 1)

    await assert.rejects(guardarEstado(cuestionario, cuestionario.estado), (err: unknown) => {
      assert.ok(err instanceof ErrorCuestionario)
      assert.equal(err.estadoHttp, 409)
      return true
    })
  })

  it('registra las llamadas a Claude del cuestionario', async () => {
    const { cuestionario } = await crearCuestionario('Inmobiliaria', 'i@i.com')
    await registradorDeLlamadas(cuestionario.id)({
      paso: 'evaluar_triage',
      modelo: 'claude-opus-5',
      stopReason: 'end_turn',
      tokensEntrada: 120,
      tokensSalida: 40,
      tokensCacheEscritos: 5000,
      tokensCacheLeidos: 0,
      duracionMs: 900,
      error: null,
    })
    const base = await db()
    const { rows } = await base.consulta<{ paso: string; tokens_cache_escritos: number }>(
      'SELECT paso, tokens_cache_escritos FROM llamadas_ia WHERE cuestionario_id = $1',
      [cuestionario.id],
    )
    assert.deepEqual(rows, [{ paso: 'evaluar_triage', tokens_cache_escritos: 5000 }])
  })
})
