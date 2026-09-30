import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ErrorCuestionario } from '../lib/cuestionarios'
import {
  bytesAbiertos,
  bytesRecibidos,
  borrarSubidasDeGrupo,
  cancelarSubida,
  carpetaSubidas,
  crearSubida,
  leerSubida,
  limpiarSubidasVencidas,
  marcarTerminada,
  MAXIMO_SUBIDAS_ABIERTAS,
  recibirParte,
  renombrarGrupoDeSubidas,
  rutaDeParte,
  rutaTemporal,
  subidaAbierta,
} from '../lib/subidas'

/*
 * Las subidas por partes, contra una carpeta descartable. No tocan la base: una subida a medias
 * todavía no es parte de ningún cuestionario.
 */
process.env.DIR_DATOS = mkdtempSync(join(tmpdir(), 'cuestionario-subidas-'))

const HORA = 60 * 60_000
let cuenta = 0
/** Un cuestionario distinto por prueba, para que las subidas de una no cuenten en otra. */
const otroCuestionario = () => `CUE-PRUEBA${++cuenta}`

const video = { nombre: 'video.mp4', bytes: 10, grupo: 'Laura', grupoElegido: false }

const rechazaCon = (estadoHttp: number, motivo?: string) => (err: unknown) => {
  assert.ok(err instanceof ErrorCuestionario, `se esperaba ErrorCuestionario y llegó ${err}`)
  assert.equal(err.estadoHttp, estadoHttp)
  assert.equal(err.motivo, motivo)
  return true
}

/** Hace de cuenta que la última parte llegó hace `horas`. */
function envejecer(ruta: string, horas: number) {
  const cuando = new Date(Date.now() - horas * HORA)
  utimesSync(ruta, cuando, cuando)
}

describe('subida por partes', () => {
  it('recibe las partes en orden y queda con el archivo entero', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    assert.match(subida.id, /^[0-9a-f-]{36}$/)
    assert.equal(await bytesRecibidos(id, subida.id), 0)

    assert.equal(await recibirParte(id, subida.id, 0, Buffer.from('0123')), 4)
    assert.equal(await recibirParte(id, subida.id, 4, Buffer.from('4567')), 8)
    assert.equal(await recibirParte(id, subida.id, 8, Buffer.from('89')), 10)
    assert.equal(readFileSync(rutaDeParte(id, subida.id), 'utf8'), '0123456789')
    assert.deepEqual(await leerSubida(id, subida.id), { ...subida, terminada: false, resultado: null })
  })

  it('mandar dos veces la misma parte, o una que pisa lo anterior, no rompe nada', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    await recibirParte(id, subida.id, 0, Buffer.from('0123'))
    // La respuesta de la primera se perdió y el navegador la manda de nuevo.
    assert.equal(await recibirParte(id, subida.id, 0, Buffer.from('0123')), 4)
    assert.equal(await recibirParte(id, subida.id, 2, Buffer.from('2345')), 6)
    assert.equal(await recibirParte(id, subida.id, 0, Buffer.from('01')), 6)
    assert.equal(readFileSync(rutaDeParte(id, subida.id), 'utf8'), '012345')
  })

  it('una parte adelantada avisa desde dónde hay que seguir', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    await recibirParte(id, subida.id, 0, Buffer.from('0123'))
    await assert.rejects(recibirParte(id, subida.id, 6, Buffer.from('67')), (err: unknown) => {
      rechazaCon(409, 'faltan_bytes')(err)
      assert.deepEqual((err as ErrorCuestionario).extra, { recibidos: 4 })
      return true
    })
    assert.equal(await bytesRecibidos(id, subida.id), 4)
  })

  it('no acepta más bytes de los que declaró', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    await assert.rejects(recibirParte(id, subida.id, 0, Buffer.alloc(11)), rechazaCon(400))
    await recibirParte(id, subida.id, 0, Buffer.alloc(8))
    await assert.rejects(recibirParte(id, subida.id, 8, Buffer.alloc(3)), rechazaCon(400))
  })

  it('una subida que no existe, venció o trae un id raro es 410, nunca 404', async () => {
    const id = otroCuestionario()
    const vencida = rechazaCon(410, 'subida_vencida')
    await assert.rejects(recibirParte(id, '00000000-0000-0000-0000-000000000000', 0, Buffer.from('x')), vencida)
    await assert.rejects(leerSubida(id, '../../../etc/passwd'), vencida)
    const subida = await crearSubida(id, video)
    await cancelarSubida(id, subida.id)
    await assert.rejects(recibirParte(id, subida.id, 0, Buffer.from('x')), vencida)
    // Cancelar dos veces, o algo que no existe, no es un error.
    await cancelarSubida(id, subida.id)
    await cancelarSubida(id, 'no-es-un-id')
  })

  it('terminada, guarda el resultado, borra las partes y sigue contestando igual', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    await recibirParte(id, subida.id, 0, Buffer.alloc(10))
    const resultado = { agregados: 1, repetidos: 0, omitidos: [], grupos: ['Laura'] }
    await marcarTerminada(id, subida.id, resultado)
    assert.equal(existsSync(rutaDeParte(id, subida.id)), false)
    assert.deepEqual((await leerSubida(id, subida.id)).resultado, resultado)
    // Una parte que llega tarde no da error: ya está todo.
    assert.equal(await recibirParte(id, subida.id, 0, Buffer.alloc(4)), 10)
  })
})

describe('subidas a medias', () => {
  it('la misma subida (nombre, tamaño y conversación) se encuentra para retomarla', async () => {
    const id = otroCuestionario()
    const subida = await crearSubida(id, video)
    await recibirParte(id, subida.id, 0, Buffer.from('0123'))
    assert.equal((await subidaAbierta(id, video))?.id, subida.id)
    for (const otra of [{ ...video, bytes: 11 }, { ...video, nombre: 'otro.mp4' }, { ...video, grupo: 'Pablo' }, { ...video, grupo: null }]) {
      assert.equal(await subidaAbierta(id, otra), null)
    }
    await marcarTerminada(id, subida.id, { agregados: 1, repetidos: 0, omitidos: [], grupos: ['Laura'] })
    assert.equal(await subidaAbierta(id, video), null)
  })

  it('no deja abrir más de seis a la vez, pero las abandonadas no cuentan', async () => {
    const id = otroCuestionario()
    const abiertas = []
    for (let i = 0; i < MAXIMO_SUBIDAS_ABIERTAS; i++) abiertas.push(await crearSubida(id, { ...video, nombre: `v${i}.mp4` }))
    assert.equal(await bytesAbiertos(id), 10 * MAXIMO_SUBIDAS_ABIERTAS)
    await assert.rejects(crearSubida(id, { ...video, nombre: 'una-mas.mp4' }), rechazaCon(429))

    // Dos quedaron sin partes nuevas hace tres horas: la pestaña se cerró. Ya no ocupan cupo ni espacio.
    // La fecha de creación también es vieja: se hace de cuenta que todo pasó hace tres horas.
    for (const abandonada of abiertas.slice(0, 2)) {
      const datos = join(carpetaSubidas(id), `${abandonada.id}.json`)
      writeFileSync(datos, JSON.stringify({ ...abandonada, creada: Date.now() - 3 * HORA }))
      envejecer(rutaDeParte(id, abandonada.id), 3)
    }
    assert.equal(await bytesAbiertos(id), 10 * (MAXIMO_SUBIDAS_ABIERTAS - 2))
    await crearSubida(id, { ...video, nombre: 'una-mas.mp4' })
  })

  it('al renombrar o quitar una conversación, sus subidas a medias la siguen', async () => {
    const id = otroCuestionario()
    const deLaura = await crearSubida(id, video)
    const dePablo = await crearSubida(id, { ...video, grupo: 'Pablo' })
    const suelta = await crearSubida(id, { ...video, grupo: null })

    await renombrarGrupoDeSubidas(id, 'Laura', 'Laura (Gol Trend)')
    assert.equal((await leerSubida(id, deLaura.id)).grupo, 'Laura (Gol Trend)')
    assert.equal((await leerSubida(id, dePablo.id)).grupo, 'Pablo')

    await borrarSubidasDeGrupo(id, 'Pablo')
    await assert.rejects(leerSubida(id, dePablo.id), rechazaCon(410, 'subida_vencida'))
    assert.equal(existsSync(rutaDeParte(id, dePablo.id)), false)
    assert.equal((await leerSubida(id, suelta.id)).grupo, null)
  })

  it('la limpieza borra lo que tiene más de un día y deja lo demás', async () => {
    const vieja = otroCuestionario()
    const nueva = otroCuestionario()
    const abandonada = await crearSubida(vieja, video)
    const temporal = await rutaTemporal(vieja)
    writeFileSync(temporal, 'quedó de un pedido que se cortó')
    for (const nombre of readdirSync(carpetaSubidas(vieja))) envejecer(join(carpetaSubidas(vieja), nombre), 25)
    const reciente = await crearSubida(nueva, video)

    await limpiarSubidasVencidas()
    assert.equal(existsSync(carpetaSubidas(vieja)), false)
    await assert.rejects(leerSubida(vieja, abandonada.id), rechazaCon(410, 'subida_vencida'))
    assert.equal((await leerSubida(nueva, reciente.id)).id, reciente.id)
  })

  it('crea la carpeta aunque el volumen no la traiga', async () => {
    // El volumen de producción ya tenía datos cuando se agregaron las subidas: la carpeta no existe.
    const id = otroCuestionario()
    assert.equal(existsSync(carpetaSubidas(id)), false)
    await crearSubida(id, video)
    assert.equal(existsSync(carpetaSubidas(id)), true)
  })
})
