import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ErrorCuestionario, guardarEstado } from '../lib/cuestionarios'
import type { EstadoPublico } from '../lib/estado-publico'
import { LIMITE_ARCHIVOS, LIMITE_BYTES_ARCHIVO, LIMITE_BYTES_CUESTIONARIO, TAMANO_PARTE } from '../lib/limites'
import { ErrorEntrada } from '../lib/motor/motor'
import * as textos from '../lib/motor/textos'
import type { EstadoCuestionario } from '../lib/motor/tipos'
import {
  cancelarSubida,
  carpetaArchivos,
  crearSubida,
  empezarCuestionario,
  estadoPublico,
  leerCuestionario,
  quitarArchivo,
  quitarConversacion,
  recibirEntrada,
  recibirParte,
  renombrarConversacion,
  subirArchivos,
  terminarSubida,
} from '../lib/proceso'
import { leerSubida, rutaDeParte } from '../lib/subidas'
import { levantarServidor, textoDelMail } from './smtp-falso'
import { armarZip, AUDIO_OGG, JPEG, PDF, VIDEO_MP4 } from './zip-de-prueba'

/*
 * La capa que usan las rutas de la API, contra una base PGlite descartable. Ninguno de estos
 * caminos llama a Claude: pegar material y subir archivos no pasan por la IA. Tampoco necesitan
 * ffmpeg ni el transcriptor: los archivos de prueba son cabeceras inventadas, y la transcripción
 * adelantada queda apagada para que no se lance nada en segundo plano.
 */
process.env.DIR_DATOS = mkdtempSync(join(tmpdir(), 'cuestionario-proceso-'))
process.env.ADELANTAR_TRANSCRIPCION = '0'
delete process.env.DATABASE_URL
delete process.env.SMTP_HOST
delete process.env.URL_PUBLICA
process.env.CODIGO_ACCESO = 'codigo-de-prueba'
process.env.TOPE_CUESTIONARIOS_POR_DIA = '1000'

/** Con `motivo`, controla también lo que la pantalla usa para decidir qué hacer. */
const rechazaCon = (estadoHttp: number, motivo?: string) => (err: unknown) => {
  assert.ok(err instanceof ErrorCuestionario, `se esperaba ErrorCuestionario y llegó ${err}`)
  assert.equal(err.estadoHttp, estadoHttp, err.message)
  if (motivo !== undefined) assert.equal(err.motivo, motivo)
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
    await assert.rejects(leerCuestionario('no-existe'), rechazaCon(404, 'link'))
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

// ---------------------------------------------------------------------------------------------
// Archivos y conversaciones
// ---------------------------------------------------------------------------------------------

const CHAT_DE_ANA = `[1/3/26, 10:15:02] Ana: Hola, ¿tienen fundas para un Gol?
[1/3/26, 10:16:40] Tapicería Norte: Sí, te paso un audio <adjunto: 00000002-AUDIO-2026-03-01.opus>
[1/3/26, 10:17:05] Tapicería Norte: <adjunto: 00000003-PHOTO-2026-03-01.jpg>
[1/3/26, 10:18:00] Ana: <adjunto: 00000004-VIDEO-2026-03-01.mp4>`

const CHAT_DE_BETO = `[2/3/26, 9:00:00] Beto: Buenas, ¿cuánto sale el cubrevolante?
[2/3/26, 9:01:30] Tapicería Norte: $15.000 <adjunto: 00000002-AUDIO-2026-03-02.opus>`

/** Un archivo como lo manda el navegador en el formulario. */
const archivoDe = (nombre: string, datos: Buffer | string) => new File([new Uint8Array(typeof datos === 'string' ? Buffer.from(datos) : datos)], nombre)

/** El .zip que exporta WhatsApp de una conversación: el chat y sus adjuntos, sin carpetas. */
function zipDeAna(): Buffer {
  return armarZip([
    { nombre: '_chat.txt', contenido: CHAT_DE_ANA },
    { nombre: '00000002-AUDIO-2026-03-01.opus', contenido: AUDIO_OGG, guardada: true },
    { nombre: '00000003-PHOTO-2026-03-01.jpg', contenido: JPEG, guardada: true },
    { nombre: '00000004-VIDEO-2026-03-01.mp4', contenido: VIDEO_MP4, guardada: true },
  ])
}

async function enEtapaDeMaterial() {
  const { token } = await nuevo()
  const cuestionario = await leerCuestionario(token)
  await guardarEstado(cuestionario, enMaterial(cuestionario.estado))
  return token
}

/** Lo que hay en el disco de un cuestionario, sin contar las carpetas de caché. */
async function enElDisco(token: string): Promise<string[]> {
  const { id } = await leerCuestionario(token)
  if (!existsSync(carpetaArchivos(id))) return []
  return readdirSync(carpetaArchivos(id)).filter((nombre) => nombre !== 'transcripciones')
}

/** Sube por partes, como hace la pantalla con todo lo que pasa de unos pocos KB. */
async function subirPorPartes(token: string, nombre: string, datos: Buffer, grupo: string | null = null, grupoElegido = false) {
  const creada = await crearSubida(token, { nombre, bytes: datos.length, grupo, grupoElegido })
  assert.equal(creada.tamanoParte, TAMANO_PARTE)
  for (let desde = creada.recibidos; desde < datos.length; desde += TAMANO_PARTE) {
    const parte = datos.subarray(desde, desde + TAMANO_PARTE)
    assert.deepEqual(await recibirParte(token, creada.id, desde, parte), { recibidos: desde + parte.length })
  }
  return { id: creada.id, resultado: await terminarSubida(token, creada.id) }
}

function archivosDe(estado: EstadoPublico) {
  assert.ok(estado.pantalla.tipo === 'material' || estado.pantalla.tipo === 'pedido_chat')
  return estado.pantalla.archivos
}

describe('subir archivos sueltos', () => {
  it('fuera del material no se puede subir, quitar ni renombrar nada', async () => {
    const { token } = await nuevo()
    const fueraDeEtapa = rechazaCon(409, 'etapa')
    await assert.rejects(subirArchivos(token, [archivoDe('chat.txt', 'hola')]), fueraDeEtapa)
    await assert.rejects(crearSubida(token, { nombre: 'v.mp4', bytes: 10, grupo: null, grupoElegido: false }), fueraDeEtapa)
    await assert.rejects(quitarConversacion(token, 'Ana'), fueraDeEtapa)
    await assert.rejects(renombrarConversacion(token, 'Ana', 'Otra'), fueraDeEtapa)
    assert.deepEqual(await enElDisco(token), [])
  })

  it('acepta todo: lo que se puede leer queda para leer y lo que no, guardado con su nota', async () => {
    const token = await enEtapaDeMaterial()
    const guion = await subirArchivos(token, [archivoDe('guion.txt', 'Hola, gracias por escribirnos.\nTrabajamos solo con cuero ecológico.')])
    assert.deepEqual(guion.subida, { agregados: 1, repetidos: 0, omitidos: [], grupos: [null] })
    // La respuesta sigue siendo un estado: una pestaña vieja que quedó abierta la entiende igual.
    assert.equal(guion.etapa, 'material')
    assert.equal(archivosDe(guion)[0].tipo, 'texto')
    assert.equal(archivosDe(guion)[0].estado, 'listo')

    const varios = await subirArchivos(token, [
      archivoDe('nota de voz.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0]), Buffer.alloc(40)])),
      archivoDe('planilla.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
      archivoDe('00000009-STICKER-2026-03-01.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])),
    ])
    assert.equal(varios.subida.agregados, 3)
    const [, audio, excel, sticker] = archivosDe(varios)
    assert.deepEqual([audio.tipo, audio.estado, audio.problema], ['audio', 'sin_leer', null])
    assert.deepEqual([excel.tipo, excel.estado], ['otro', 'con_problema'])
    assert.match(excel.problema ?? '', /\.docx o \.xlsx/)
    // Un sticker no se manda a leer: queda listo, sin texto.
    assert.deepEqual([sticker.tipo, sticker.estado], ['imagen', 'listo'])

    const guardado = await leerCuestionario(token)
    const archivo = guardado.estado.material.archivos[0]
    assert.match(archivo.texto ?? '', /cuero ecológico/)
    assert.match(archivo.hash ?? '', /^[0-9a-f]{64}$/)
    assert.ok(existsSync(join(carpetaArchivos(guardado.id), archivo.id)))
    assert.equal((await enElDisco(token)).length, 4)

    const sinArchivo = await quitarArchivo(token, archivo.id)
    assert.equal(archivosDe(sinArchivo).length, 3)
    assert.equal(existsSync(join(carpetaArchivos(guardado.id), archivo.id)), false)
    // Un doble toque en «Quitar» no es un 404: con un 404 la pantalla daría el link por inválido.
    await assert.rejects(quitarArchivo(token, archivo.id), rechazaCon(409, 'ya_no_esta'))
  })

  it('un archivo vacío frena el pedido entero y no deja nada guardado', async () => {
    const token = await enEtapaDeMaterial()
    await assert.rejects(subirArchivos(token, [archivoDe('bueno.txt', 'hola'), archivoDe('vacio.txt', '')]), (err: unknown) => {
      rechazaCon(400)(err)
      assert.match((err as Error).message, /^vacio\.txt: .*vacío/)
      return true
    })
    await assert.rejects(subirArchivos(token, []), rechazaCon(400))
    assert.equal((await leerCuestionario(token)).estado.material.archivos.length, 0)
    assert.deepEqual(await enElDisco(token), [])
  })

  it('con la conversación que eligió la persona, y sin repetir lo que ya estaba', async () => {
    const token = await enEtapaDeMaterial()
    const foto = archivoDe('captura 1.jpg', JPEG)
    const primera = await subirArchivos(token, [foto], '  Venta cerrada - María  ', true)
    assert.deepEqual(primera.subida.grupos, ['Venta cerrada - María'])
    assert.equal(archivosDe(primera)[0].grupo, 'Venta cerrada - María')

    const repetida = await subirArchivos(token, [foto, archivoDe('captura 2.jpg', Buffer.concat([JPEG, Buffer.from('otra')]))], 'Venta cerrada - María', true)
    assert.deepEqual(repetida.subida, { agregados: 1, repetidos: 1, omitidos: [], grupos: ['Venta cerrada - María'] })
    // La misma foto en otra conversación no es una repetida: dos clientes pueden recibir la misma lista.
    const enOtra = await subirArchivos(token, [foto], 'Otra conversación', true)
    assert.equal(enOtra.subida.agregados, 1)
    assert.equal(archivosDe(enOtra).length, 3)
    assert.equal((await enElDisco(token)).length, 3)
  })

  it('el chat suelto arma su propia conversación y las fotos que nombra se le suman solas', async () => {
    const token = await enEtapaDeMaterial()
    // Como queda en Android: el .txt y los adjuntos sueltos, subidos en cualquier orden.
    await subirArchivos(token, [archivoDe('00000003-PHOTO-2026-03-01.jpg', JPEG)])
    const conChat = await subirArchivos(token, [archivoDe('Chat de WhatsApp con Ana.txt', CHAT_DE_ANA), archivoDe('lista de precios.pdf', PDF)])
    assert.deepEqual(conChat.subida.grupos, ['Chat de WhatsApp con Ana', null])
    const porNombre = Object.fromEntries(archivosDe(conChat).map((a) => [a.nombre, a]))
    assert.equal(porNombre['Chat de WhatsApp con Ana.txt'].esChat, true)
    assert.equal(porNombre['00000003-PHOTO-2026-03-01.jpg'].grupo, 'Chat de WhatsApp con Ana')
    assert.equal(porNombre['lista de precios.pdf'].grupo, null)

    // Otro chat suelto que se llama igual es otra conversación: no se juntan.
    const otro = await subirArchivos(token, [archivoDe('Chat de WhatsApp con Ana.txt', CHAT_DE_BETO)])
    assert.deepEqual(otro.subida.grupos, ['Chat de WhatsApp con Ana (2)'])
  })

  it('a una conversación con chat no se le puede sumar otro chat distinto', async () => {
    const token = await enEtapaDeMaterial()
    await subirArchivos(token, [archivoDe('_chat.txt', CHAT_DE_ANA), archivoDe('foto.jpg', JPEG)], 'Cliente', false)
    // La carpeta «Cliente» de otra carpeta madre: la pantalla tiene que renombrar el lote entero.
    await assert.rejects(subirArchivos(token, [archivoDe('_chat.txt', CHAT_DE_BETO), archivoDe('audio.opus', AUDIO_OGG)], 'Cliente', false), rechazaCon(409, 'grupo_con_otro_chat'))
    assert.equal((await leerCuestionario(token)).estado.material.archivos.length, 2)
    assert.equal((await enElDisco(token)).length, 2)

    // El mismo chat de nuevo es la misma conversación; y un adjunto más siempre se puede sumar.
    const igual = await subirArchivos(token, [archivoDe('_chat.txt', CHAT_DE_ANA), archivoDe('audio.opus', AUDIO_OGG)], 'Cliente', false)
    assert.deepEqual(igual.subida, { agregados: 1, repetidos: 1, omitidos: [], grupos: ['Cliente'] })
  })

  it('dos subidas a la vez no se pisan: la segunda vuelve a decidir con el estado nuevo', async () => {
    const token = await enEtapaDeMaterial()
    const resultados = await Promise.all([
      subirArchivos(token, [archivoDe('uno.txt', 'uno')]),
      subirArchivos(token, [archivoDe('dos.txt', 'dos')]),
    ])
    assert.deepEqual(resultados.map((r) => r.subida.agregados), [1, 1])
    const nombres = (await leerCuestionario(token)).estado.material.archivos.map((a) => a.nombre).sort()
    assert.deepEqual(nombres, ['dos.txt', 'uno.txt'])
    assert.equal((await enElDisco(token)).length, 2)
  })

  it('un PDF de más de 22 MB queda guardado con su nota y no se manda a leer', async () => {
    const token = await enEtapaDeMaterial()
    const pesado = Buffer.alloc(22 * 1024 * 1024 + 1)
    PDF.copy(pesado)
    const { resultado } = await subirPorPartes(token, 'catálogo entero.pdf', pesado)
    assert.deepEqual([archivosDe(resultado)[0].tipo, archivosDe(resultado)[0].estado], ['pdf', 'con_problema'])
    assert.equal(archivosDe(resultado)[0].problema, textos.PROBLEMA_PDF_PESADO)
  })
})

describe('subir el .zip de una conversación', () => {
  it('por partes: el .zip se abre y cada archivo queda en la conversación del .zip', async () => {
    const token = await enEtapaDeMaterial()
    // Un video que no se comprime, para que el .zip pase de una parte y haya que mandar varias.
    const video = Buffer.concat([VIDEO_MP4, randomBytes(3 * TAMANO_PARTE)])
    const zip = armarZip([
      { nombre: '_chat.txt', contenido: CHAT_DE_ANA },
      { nombre: '00000002-AUDIO-2026-03-01.opus', contenido: AUDIO_OGG, guardada: true },
      { nombre: '00000003-PHOTO-2026-03-01.jpg', contenido: JPEG, guardada: true },
      { nombre: '00000004-VIDEO-2026-03-01.mp4', contenido: video, guardada: true },
    ])
    assert.ok(zip.length > 3 * TAMANO_PARTE)

    const creada = await crearSubida(token, { nombre: 'WhatsApp Chat - Ana.zip', bytes: zip.length, grupo: null, grupoElegido: false })
    assert.deepEqual([creada.recibidos, creada.tamanoParte], [0, TAMANO_PARTE])
    await recibirParte(token, creada.id, 0, zip.subarray(0, TAMANO_PARTE))
    // Una parte que se adelanta: hay que seguir desde donde quedó.
    await assert.rejects(recibirParte(token, creada.id, 2 * TAMANO_PARTE, zip.subarray(2 * TAMANO_PARTE, 3 * TAMANO_PARTE)), (err: unknown) => {
      rechazaCon(409, 'faltan_bytes')(err)
      assert.deepEqual((err as ErrorCuestionario).extra, { recibidos: TAMANO_PARTE })
      return true
    })
    // Terminar antes de tiempo tampoco rompe nada.
    await assert.rejects(terminarSubida(token, creada.id), rechazaCon(409, 'faltan_bytes'))
    // Se recargó la página: elegir el mismo archivo retoma la subida en vez de empezar otra.
    const retomada = await crearSubida(token, { nombre: 'WhatsApp Chat - Ana.zip', bytes: zip.length, grupo: null, grupoElegido: false })
    assert.deepEqual([retomada.id, retomada.recibidos], [creada.id, TAMANO_PARTE])
    for (let desde = TAMANO_PARTE; desde < zip.length; desde += TAMANO_PARTE) {
      await recibirParte(token, creada.id, desde, zip.subarray(desde, desde + TAMANO_PARTE))
    }

    // Dos pedidos de terminar a la vez (la pantalla reintenta si tarda) dan lo mismo y no abren el .zip dos veces.
    const [resultado, otraVez] = await Promise.all([terminarSubida(token, creada.id), terminarSubida(token, creada.id)])
    assert.deepEqual(resultado.subida, { agregados: 4, repetidos: 0, omitidos: [], grupos: ['WhatsApp Chat - Ana'] })
    assert.deepEqual(otraVez.subida, resultado.subida)
    const archivos = archivosDe(resultado)
    assert.deepEqual(
      archivos.map((a) => [a.nombre, a.tipo, a.grupo, a.esChat]),
      [
        ['_chat.txt', 'texto', 'WhatsApp Chat - Ana', true],
        ['00000002-AUDIO-2026-03-01.opus', 'audio', 'WhatsApp Chat - Ana', false],
        ['00000003-PHOTO-2026-03-01.jpg', 'imagen', 'WhatsApp Chat - Ana', false],
        ['00000004-VIDEO-2026-03-01.mp4', 'video', 'WhatsApp Chat - Ana', false],
      ],
    )
    assert.equal(archivos[3].bytes, video.length)
    // En el disco quedan los cuatro archivos, cada uno con su id; el .zip no se guarda.
    assert.deepEqual((await enElDisco(token)).sort(), archivos.map((a) => a.id).sort())

    // Repetirlo después devuelve el mismo resultado, con el estado de ahora.
    const despues = await terminarSubida(token, creada.id)
    assert.deepEqual(despues.subida, resultado.subida)
    assert.equal(archivosDe(despues).length, 4)
    const { id } = await leerCuestionario(token)
    assert.equal(existsSync(rutaDeParte(id, creada.id)), false)
  })

  it('subir dos veces la misma conversación no la duplica', async () => {
    const token = await enEtapaDeMaterial()
    const primera = await subirArchivos(token, [archivoDe('WhatsApp Chat - Ana.zip', zipDeAna())])
    assert.equal(primera.subida.agregados, 4)
    const segunda = await subirArchivos(token, [archivoDe('WhatsApp Chat - Ana.zip', zipDeAna())])
    assert.deepEqual(segunda.subida, { agregados: 0, repetidos: 4, omitidos: [], grupos: ['WhatsApp Chat - Ana'] })
    assert.equal(archivosDe(segunda).length, 4)
    assert.equal((await enElDisco(token)).length, 4)
  })

  it('otro .zip con el mismo nombre y otro chat es otra conversación: va a «Nombre (2)»', async () => {
    const token = await enEtapaDeMaterial()
    await subirArchivos(token, [archivoDe('WhatsApp Chat.zip', zipDeAna())])
    const deBeto = armarZip([
      { nombre: '_chat.txt', contenido: CHAT_DE_BETO },
      // Un audio con el mismo nombre que uno de Ana: cada chat tiene que quedarse con el suyo.
      { nombre: '00000002-AUDIO-2026-03-02.opus', contenido: Buffer.concat([AUDIO_OGG, Buffer.from('beto')]), guardada: true },
    ])
    const segundo = await subirArchivos(token, [archivoDe('WhatsApp Chat.zip', deBeto)])
    assert.deepEqual(segundo.subida.grupos, ['WhatsApp Chat (2)'])
    const tercero = await subirArchivos(token, [archivoDe('WhatsApp Chat.zip', armarZip([{ nombre: '_chat.txt', contenido: `${CHAT_DE_BETO}\n[2/3/26, 9:05:00] Beto: dale` }]))])
    assert.deepEqual(tercero.subida.grupos, ['WhatsApp Chat (3)'])

    const grupos = archivosDe(tercero).map((a) => a.grupo)
    assert.deepEqual([...new Set(grupos)], ['WhatsApp Chat', 'WhatsApp Chat (2)', 'WhatsApp Chat (3)'])
    assert.equal(grupos.filter((g) => g === 'WhatsApp Chat').length, 4)
  })

  it('la conversación que eligió la persona le gana al nombre del .zip, salvo que ya tenga otro chat', async () => {
    const token = await enEtapaDeMaterial()
    const elegida = await subirArchivos(token, [archivoDe('WhatsApp Chat - Ana.zip', zipDeAna())], 'Venta cerrada - Ana', true)
    assert.deepEqual(elegida.subida.grupos, ['Venta cerrada - Ana'])
    const otroChat = await subirArchivos(token, [archivoDe('otro.zip', armarZip([{ nombre: '_chat.txt', contenido: CHAT_DE_BETO }]))], 'Venta cerrada - Ana', true)
    assert.deepEqual(otroChat.subida.grupos, ['Venta cerrada - Ana (2)'])
    // Un .zip con un chat subido como «otros archivos» es una conversación igual: no queda suelto.
    const comoSuelto = await subirArchivos(token, [archivoDe('Chat con Carla.zip', armarZip([{ nombre: '_chat.txt', contenido: `${CHAT_DE_BETO}\n[2/3/26, 9:09:00] Beto: ok` }]))], null, true)
    assert.deepEqual(comoSuelto.subida.grupos, ['Chat con Carla'])
    // Y uno sin chat, subido como «otros archivos», sí queda suelto.
    const catalogo = await subirArchivos(token, [archivoDe('catálogo.zip', armarZip([{ nombre: 'fotos/a.jpg', contenido: JPEG }]))], null, true)
    assert.deepEqual(catalogo.subida.grupos, [null])
  })

  it('el .zip de la carpeta madre da una conversación por carpeta; lo de la raíz queda suelto y un .zip de adentro se abre', async () => {
    const token = await enEtapaDeMaterial()
    const interno = armarZip([
      { nombre: '_chat.txt', contenido: `${CHAT_DE_BETO}\n[2/3/26, 9:10:00] Beto: gracias` },
      { nombre: '00000002-AUDIO-2026-03-02.opus', contenido: AUDIO_OGG },
    ])
    const madre = armarZip([
      { nombre: 'Conversaciones/1 - Venta/_chat.txt', contenido: CHAT_DE_ANA },
      { nombre: 'Conversaciones/1 - Venta/Audios y videos/00000002-AUDIO-2026-03-01.opus', contenido: AUDIO_OGG },
      { nombre: 'Conversaciones/2 - No compró/_chat.txt', contenido: CHAT_DE_BETO },
      { nombre: 'Conversaciones/lista de precios.pdf', contenido: PDF },
      { nombre: 'Conversaciones/__MACOSX/._lista de precios.pdf', contenido: 'basura de Mac' },
      { nombre: 'Conversaciones/con clave.pdf', contenido: PDF, cifrada: true },
      { nombre: 'Conversaciones/WhatsApp Chat - Carla.zip', contenido: interno, guardada: true },
    ])
    const resultado = await subirArchivos(token, [archivoDe('Todo junto.zip', madre)])
    assert.deepEqual(resultado.subida.omitidos, [{ nombre: 'Conversaciones/con clave.pdf', motivo: 'cifrado' }])
    assert.equal(resultado.subida.agregados, 6)
    assert.deepEqual(
      archivosDe(resultado).map((a) => [a.nombre, a.grupo]),
      [
        ['_chat.txt', '1 - Venta'],
        ['00000002-AUDIO-2026-03-01.opus', '1 - Venta'],
        ['_chat.txt', '2 - No compró'],
        ['lista de precios.pdf', null],
        ['_chat.txt', 'WhatsApp Chat - Carla'],
        ['00000002-AUDIO-2026-03-02.opus', 'WhatsApp Chat - Carla'],
      ],
    )
    // Ni el .zip de afuera ni el de adentro quedan en el disco: solo lo que traían.
    assert.equal((await enElDisco(token)).length, 6)
  })

  it('un PowerPoint no se abre como si fuera una conversación', async () => {
    const token = await enEtapaDeMaterial()
    const pptx = armarZip([
      { nombre: '[Content_Types].xml', contenido: '<Types/>' },
      { nombre: 'ppt/presentation.xml', contenido: '<p/>' },
      { nombre: 'ppt/media/image1.jpg', contenido: JPEG },
    ])
    const resultado = await subirArchivos(token, [archivoDe('catálogo.pptx', pptx), archivoDe('disfrazado.zip', pptx)])
    assert.equal(resultado.subida.agregados, 2)
    assert.deepEqual(archivosDe(resultado).map((a) => [a.tipo, a.estado]), [['otro', 'con_problema'], ['otro', 'con_problema']])
  })

  it('un .zip dañado o vacío frena con un mensaje que dice qué hacer, y no deja nada', async () => {
    const token = await enEtapaDeMaterial()
    const entero = zipDeAna()
    await assert.rejects(subirArchivos(token, [archivoDe('roto.zip', entero.subarray(0, entero.length - 40))]), (err: unknown) => {
      rechazaCon(400)(err)
      assert.match((err as Error).message, /^roto\.zip: .*dañado/)
      return true
    })
    await assert.rejects(subirArchivos(token, [archivoDe('vacio.zip', armarZip([{ nombre: 'carpeta/', contenido: '', guardada: true }]))]), rechazaCon(400))
    assert.deepEqual(await enElDisco(token), [])
  })

  it('los límites se controlan después de abrir el .zip, y si no entra no queda nada', async () => {
    const token = await enEtapaDeMaterial()
    const muchos = armarZip(Array.from({ length: LIMITE_ARCHIVOS + 1 }, (_, i) => ({ nombre: `foto ${i}.txt`, contenido: `foto ${i}`, guardada: true })))
    await assert.rejects(subirArchivos(token, [archivoDe('muchas fotos.zip', muchos)]), (err: unknown) => {
      rechazaCon(400)(err)
      assert.match((err as Error).message, /hasta 400 archivos/)
      return true
    })
    assert.equal((await leerCuestionario(token)).estado.material.archivos.length, 0)
    assert.deepEqual(await enElDisco(token), [])

    // Con el cuestionario casi lleno, un .zip que declara más de lo que queda ni se abre.
    const cuestionario = await leerCuestionario(token)
    const casiLleno = structuredClone(cuestionario.estado)
    casiLleno.material.archivos.push({ id: 'grande', nombre: 'video.mp4', mime: 'video/mp4', tipo: 'video', bytes: LIMITE_BYTES_CUESTIONARIO - 50, texto: '', etapa: 'material' })
    await guardarEstado(cuestionario, casiLleno)
    await assert.rejects(subirArchivos(token, [archivoDe('Ana.zip', zipDeAna())]), (err: unknown) => {
      rechazaCon(400)(err)
      assert.match((err as Error).message, /pasa el espacio que queda \(0 MB\)/)
      return true
    })
    await assert.rejects(subirArchivos(token, [archivoDe('guion.txt', 'x'.repeat(100))]), rechazaCon(400))
    await assert.rejects(crearSubida(token, { nombre: 'v.mp4', bytes: 1000, grupo: null, grupoElegido: false }), rechazaCon(400))
    assert.deepEqual(await enElDisco(token), [])
  })

  it('una subida por partes pide datos válidos', async () => {
    const token = await enEtapaDeMaterial()
    const datos = { nombre: 'v.mp4', bytes: 10, grupo: null, grupoElegido: false }
    for (const malos of [null, {}, { ...datos, nombre: '  ' }, { ...datos, bytes: 0 }, { ...datos, bytes: 1.5 }, { ...datos, bytes: '10' }, { ...datos, bytes: LIMITE_BYTES_ARCHIVO + 1 }]) {
      await assert.rejects(crearSubida(token, malos), rechazaCon(400))
    }
    const creada = await crearSubida(token, datos)
    await assert.rejects(recibirParte(token, creada.id, -1, Buffer.from('x')), rechazaCon(400))
    await assert.rejects(recibirParte(token, creada.id, 0.5, Buffer.from('x')), rechazaCon(400))
    await assert.rejects(recibirParte(token, creada.id, 0, Buffer.alloc(0)), rechazaCon(400))
    await assert.rejects(recibirParte(token, creada.id, 0, Buffer.alloc(TAMANO_PARTE + 1)), rechazaCon(400))
    await assert.rejects(recibirParte('no-existe', creada.id, 0, Buffer.from('x')), rechazaCon(404, 'link'))
    // Una subida que no existe o ya se canceló es 410: el link del cuestionario sigue siendo bueno.
    await cancelarSubida(token, creada.id)
    await assert.rejects(terminarSubida(token, creada.id), rechazaCon(410, 'subida_vencida'))
  })
})

describe('conversaciones', () => {
  async function conDosConversaciones() {
    const token = await enEtapaDeMaterial()
    await subirArchivos(token, [archivoDe('WhatsApp Chat - Ana.zip', zipDeAna())])
    await subirArchivos(token, [archivoDe('_chat.txt', CHAT_DE_BETO)], 'Beto', true)
    // Suelto, pero el chat de Ana lo nombra: figura en su conversación.
    await subirArchivos(token, [archivoDe('00000003-PHOTO-2026-03-01.jpg', Buffer.concat([JPEG, Buffer.from('otra versión')])), archivoDe('precios.pdf', PDF)])
    return token
  }

  it('cambiar el nombre mueve todos sus archivos y las subidas a medias, y no deja juntar dos', async () => {
    const token = await conDosConversaciones()
    const { id } = await leerCuestionario(token)
    const aMedias = await crearSubida(token, { nombre: 'video.mp4', bytes: 50, grupo: 'WhatsApp Chat - Ana', grupoElegido: true })

    await assert.rejects(renombrarConversacion(token, 'WhatsApp Chat - Ana', 'Beto'), rechazaCon(400))
    await assert.rejects(renombrarConversacion(token, 'WhatsApp Chat - Ana', '   '), rechazaCon(400))
    await assert.rejects(renombrarConversacion(token, 'No existe', 'Otra'), rechazaCon(409, 'ya_no_esta'))

    const renombrada = await renombrarConversacion(token, 'WhatsApp Chat - Ana', ' Venta cerrada / Ana ')
    const grupos = archivosDe(renombrada).map((a) => a.grupo)
    assert.equal(grupos.filter((g) => g === 'Venta cerrada / Ana').length, 5)
    assert.ok(!grupos.includes('WhatsApp Chat - Ana'))
    assert.equal((await leerSubida(id, aMedias.id)).grupo, 'Venta cerrada / Ana')
    // Con el mismo nombre no cambia nada y no es un error.
    assert.equal((await renombrarConversacion(token, 'Beto', 'Beto')).version, renombrada.version)
  })

  it('quitar una conversación borra sus archivos del disco y no toca las demás', async () => {
    const token = await conDosConversaciones()
    const { id } = await leerCuestionario(token)
    const aMedias = await crearSubida(token, { nombre: 'video.mp4', bytes: 50, grupo: 'WhatsApp Chat - Ana', grupoElegido: true })
    assert.equal((await enElDisco(token)).length, 7)

    const sinAna = await quitarConversacion(token, 'WhatsApp Chat - Ana')
    assert.deepEqual(
      archivosDe(sinAna).map((a) => [a.nombre, a.grupo]),
      [
        ['_chat.txt', 'Beto'],
        ['precios.pdf', null],
      ],
    )
    assert.deepEqual((await enElDisco(token)).sort(), archivosDe(sinAna).map((a) => a.id).sort())
    // La subida a medias se borra: si terminara después, resucitaría la conversación.
    await assert.rejects(leerSubida(id, aMedias.id), rechazaCon(410, 'subida_vencida'))
    await assert.rejects(quitarConversacion(token, 'WhatsApp Chat - Ana'), rechazaCon(409, 'ya_no_esta'))

    // Con null se quitan los sueltos.
    const sinSueltos = await quitarConversacion(token, null)
    assert.deepEqual(archivosDe(sinSueltos).map((a) => a.nombre), ['_chat.txt'])
    assert.equal((await enElDisco(token)).length, 1)
  })
})

describe('lo que ve la pantalla de un audio que se sigue escuchando', () => {
  it('pasa a listo cuando ya no hay nada pendiente, para que la pantalla siga sola', async () => {
    const token = await enEtapaDeMaterial()
    await subirArchivos(token, [archivoDe('nota.opus', AUDIO_OGG)])
    const cuestionario = await leerCuestionario(token)
    const estado = structuredClone(cuestionario.estado)
    // Así lo deja el motor cuando se vence el plazo de lectura.
    estado.material.archivos[0].problema = textos.PROBLEMA_EN_PROCESO
    estado.material.avisoLectura = textos.AVISO_EN_PROCESO
    const guardado = await guardarEstado(cuestionario, estado)

    // Nadie lo está transcribiendo (en las pruebas no se adelanta): no tiene sentido seguir esperando.
    const publico = estadoPublico(guardado)
    assert.ok(publico.pantalla.tipo === 'material')
    assert.equal(publico.pantalla.avisoLectura, textos.AVISO_EN_PROCESO)
    assert.deepEqual([publico.pantalla.archivos[0].estado, publico.pantalla.archivos[0].problema], ['listo', null])
  })
})
