import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ErrorCuestionario, guardarEstado } from '../lib/cuestionarios'
import { ErrorEntrada } from '../lib/motor/motor'
import type { EstadoCuestionario } from '../lib/motor/tipos'
import {
  carpetaArchivos,
  empezarCuestionario,
  estadoPublico,
  leerCuestionario,
  quitarArchivo,
  recibirEntrada,
  subirArchivos,
} from '../lib/proceso'
import { levantarServidor, textoDelMail } from './smtp-falso'

/*
 * La capa que usan las rutas de la API, contra una base PGlite descartable. Ninguno de estos
 * caminos llama a Claude: pegar material y subir archivos no pasan por la IA.
 */
process.env.DIR_DATOS = mkdtempSync(join(tmpdir(), 'cuestionario-proceso-'))
delete process.env.DATABASE_URL
delete process.env.SMTP_HOST
delete process.env.URL_PUBLICA
process.env.CODIGO_ACCESO = 'codigo-de-prueba'
process.env.TOPE_CUESTIONARIOS_POR_DIA = '1000'

const rechazaCon = (estadoHttp: number) => (err: unknown) => {
  assert.ok(err instanceof ErrorCuestionario, `se esperaba ErrorCuestionario y llegó ${err}`)
  assert.equal(err.estadoHttp, estadoHttp)
  return true
}

const datosDe = (email: string) => ({ codigo: 'codigo-de-prueba', negocio: 'Tapicería Norte', email })

/** Uno recién abierto: falla si en vez de abrirlo se retomó otro. */
async function nuevo(email = 'dueno@tapicerianorte.com') {
  const resultado = await empezarCuestionario(datosDe(email))
  assert.ok('token' in resultado, 'se esperaba un cuestionario nuevo')
  return resultado
}

function enMaterial(estado: EstadoCuestionario): EstadoCuestionario {
  return {
    ...estado,
    etapa: 'material',
    clasificacion: { accionTerminal: 'seña pagada', arquetipo: 'A', hibrido: false, procesos: [], mensaje: 'ok' },
    examen: {
      negocio: 'Tapicería Norte',
      arquetipo: 'A',
      accionTerminal: 'seña pagada',
      nota: null,
      material: ['Un chat que terminó en seña'],
      secciones: [{ numero: 1, titulo: 'Qué ofrecés', preguntas: [{ id: '1.1', texto: '¿Qué productos vendés?' }] }],
    },
  }
}

async function esperarQueTermine(token: string) {
  for (let intento = 0; intento < 100; intento++) {
    const cuestionario = await leerCuestionario(token)
    if (!estadoPublico(cuestionario).procesando) return cuestionario
    await new Promise((listo) => setTimeout(listo, 50))
  }
  throw new Error('La entrada no terminó de procesarse.')
}

/** El primer link sale en segundo plano: se espera a que llegue para no confundirlo con otro. */
async function esperarMails(mensajes: string[], cantidad: number) {
  for (let intento = 0; intento < 100 && mensajes.length < cantidad; intento++) {
    await new Promise((listo) => setTimeout(listo, 20))
  }
  assert.equal(mensajes.length, cantidad, `se esperaban ${cantidad} mails y llegaron ${mensajes.length}`)
}

describe('crear un cuestionario', () => {
  it('pide el código del link y devuelve el link personal', async () => {
    await assert.rejects(empezarCuestionario({ ...datosDe('dueno@tapicerianorte.com'), codigo: 'otro' }), rechazaCon(403))

    const { token, url } = await nuevo()
    assert.equal(url, `/c/${token}`)
    const estado = estadoPublico(await leerCuestionario(token))
    assert.equal(estado.negocio, 'Tapicería Norte')
    assert.equal(estado.email, 'dueno@tapicerianorte.com')
    assert.equal(estado.etapa, 'triage')
    assert.equal(estado.procesando, false)
    assert.equal(estado.error, null)
    assert.equal(estado.pantalla.tipo, 'pregunta')
    assert.equal(estado.progreso.porcentaje, 0)
  })

  it('respeta el tope de cuestionarios nuevos por día', async () => {
    await nuevo()
    process.env.TOPE_CUESTIONARIOS_POR_DIA = '1'
    try {
      await assert.rejects(nuevo(), rechazaCon(429))
    } finally {
      process.env.TOPE_CUESTIONARIOS_POR_DIA = '1000'
    }
  })

  it('un token que no existe es 404', async () => {
    await assert.rejects(leerCuestionario('no-existe'), rechazaCon(404))
  })
})

describe('volver a entrar con el mismo mail', () => {
  it('sin correo configurado abre otro, porque no hay cómo mandarle el link', async () => {
    const primero = await nuevo('sin-correo@ejemplo.test')
    const segundo = await nuevo('sin-correo@ejemplo.test')
    assert.notEqual(primero.token, segundo.token)
  })

  it('con correo le manda un link nuevo al que ya tenía empezado, sin romper el anterior', async () => {
    const servidor = await levantarServidor()
    Object.assign(process.env, {
      SMTP_HOST: '127.0.0.1',
      SMTP_PUERTO: String(servidor.puerto),
      SMTP_REMITENTE: 'avisos@cuestionario.test',
      SMTP_TLS: 'ninguno',
      URL_PUBLICA: 'https://cuestionario.test',
    })
    try {
      const primero = await nuevo('laura@panaderia.test')
      await esperarMails(servidor.mensajes, 1)

      const segundo = await empezarCuestionario(datosDe('Laura@Panaderia.test'))
      assert.deepEqual(segundo, { retomado: true, email: 'laura@panaderia.test' })
      await esperarMails(servidor.mensajes, 2)
      const link = /https:\/\/cuestionario\.test\/c\/([A-Za-z0-9_-]+)/.exec(textoDelMail(servidor.mensajes[1]))
      assert.ok(link, 'el mail para seguir tiene que traer el link')
      assert.notEqual(link[1], primero.token)

      const original = await leerCuestionario(primero.token)
      assert.equal((await leerCuestionario(link[1])).id, original.id)

      // Tres por hora: alcanza para quien lo perdió y frena a quien le quiera llenar la casilla a otro.
      await empezarCuestionario(datosDe('laura@panaderia.test'))
      await empezarCuestionario(datosDe('laura@panaderia.test'))
      await assert.rejects(empezarCuestionario(datosDe('laura@panaderia.test')), rechazaCon(429))
      await esperarMails(servidor.mensajes, 4)

      // Uno terminado no se retoma: con ese mail se abre otro.
      await guardarEstado(original, { ...original.estado, etapa: 'terminado' })
      await nuevo('laura@panaderia.test')
      await esperarMails(servidor.mensajes, 5)
    } finally {
      for (const nombre of ['SMTP_HOST', 'SMTP_PUERTO', 'SMTP_REMITENTE', 'SMTP_TLS', 'URL_PUBLICA']) delete process.env[nombre]
      await servidor.cerrar()
    }
  })
})

describe('recibir entradas', () => {
  it('rechaza una versión vieja y entradas que no corresponden, sin tomar el candado', async () => {
    const { token } = await nuevo()
    const cuestionario = await leerCuestionario(token)
    await assert.rejects(recibirEntrada(token, { tipo: 'respuesta', texto: 'pagó' }, cuestionario.version + 5), rechazaCon(409))
    await assert.rejects(recibirEntrada(token, { tipo: 'confirmar' }, cuestionario.version), ErrorEntrada)
    await assert.rejects(recibirEntrada(token, { tipo: 'cualquiera' }, cuestionario.version), ErrorEntrada)
    assert.equal(estadoPublico(await leerCuestionario(token)).procesando, false)
  })

  it('pegar material se procesa en segundo plano y queda en la pantalla', async () => {
    const { token } = await nuevo()
    const cuestionario = await leerCuestionario(token)
    const enEtapa = await guardarEstado(cuestionario, enMaterial(cuestionario.estado))

    const aceptado = await recibirEntrada(token, { tipo: 'texto_material', texto: 'Cliente: hola\nNegocio: ¿cómo es tu nombre?' }, enEtapa.version)
    assert.equal(aceptado.procesando, true)
    assert.ok(aceptado.mensajeEspera)

    const terminado = estadoPublico(await esperarQueTermine(token))
    assert.equal(terminado.error, null)
    assert.equal(terminado.version, enEtapa.version + 1)
    assert.ok(terminado.pantalla.tipo === 'material')
    assert.equal(terminado.pantalla.textos.length, 1)
    assert.match(terminado.pantalla.textos[0].extracto, /Cliente: hola/)
  })
})

describe('archivos', () => {
  it('sube, rechaza lo que no se acepta y quita', async () => {
    const { token } = await nuevo()
    const cuestionario = await leerCuestionario(token)
    await assert.rejects(
      subirArchivos(token, [new File([Buffer.from('hola')], 'chat.txt', { type: 'text/plain' })]),
      rechazaCon(409),
    )
    await guardarEstado(cuestionario, enMaterial(cuestionario.estado))

    const chat = new File([Buffer.from('Cliente: quiero fundas\nNegocio: ¿para qué modelo?')], 'chat.txt', { type: 'text/plain' })
    const conArchivo = await subirArchivos(token, [chat])
    assert.ok(conArchivo.pantalla.tipo === 'material')
    assert.equal(conArchivo.pantalla.archivos.length, 1)
    assert.equal(conArchivo.pantalla.archivos[0].tipo, 'texto')

    const guardado = await leerCuestionario(token)
    const archivo = guardado.estado.material.archivos[0]
    assert.match(archivo.texto ?? '', /quiero fundas/)
    assert.ok(existsSync(join(carpetaArchivos(guardado.id), archivo.id)))

    const audio = new File([Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)])], 'audio.mp3', { type: 'audio/mpeg' })
    await assert.rejects(subirArchivos(token, [audio]), (err: unknown) => {
      rechazaCon(400)(err)
      assert.match((err as Error).message, /^audio\.mp3: .*audios/)
      return true
    })
    assert.equal((await leerCuestionario(token)).estado.material.archivos.length, 1)

    const sinArchivo = await quitarArchivo(token, archivo.id)
    assert.ok(sinArchivo.pantalla.tipo === 'material')
    assert.equal(sinArchivo.pantalla.archivos.length, 0)
    assert.equal(existsSync(join(carpetaArchivos(guardado.id), archivo.id)), false)
  })
})
