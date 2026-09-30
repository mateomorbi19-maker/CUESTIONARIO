import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ladosDeImagen } from '../lib/archivos'
import { ErrorMultimedia } from '../lib/motor/motor'
import {
  analizar,
  cerrarTranscriptor,
  colapsarBucles,
  cuantosFotogramas,
  estadoMultimedia,
  fotogramasDeVideo,
  hayBucle,
  imagenParaClaude,
  leerDuracion,
  leerPistas,
  modeloDeTranscripcion,
  olvidarEstadoMultimedia,
  probarTranscriptor,
  quitarCreditosInventados,
  tieneVoz,
  transcribirAudio,
  transcripcionPendiente,
} from '../lib/multimedia'

/*
 * Audio, video e imágenes. Nada de material real: los audios y videos se generan con ffmpeg
 * (un tono, silencio, una carta de ajuste), y el transcriptor es uno falso que contesta el
 * protocolo sin cargar ningún modelo.
 *
 * Las funciones puras corren siempre. Lo que necesita ffmpeg corre solo si está: con RUTA_FFMPEG
 * definida o con «ffmpeg» en el PATH. Si no, esas pruebas se saltean.
 */

const CARPETA = mkdtempSync(join(tmpdir(), 'cuestionario-multimedia-'))
const FFMPEG = process.env.RUTA_FFMPEG?.trim() || 'ffmpeg'
const hayFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0
const sinFfmpeg = hayFfmpeg ? false : 'no hay ffmpeg: definí RUTA_FFMPEG o agregalo al PATH para correr esta prueba'

/** Genera un archivo de prueba con ffmpeg. */
function generar(nombre: string, args: string[]): string {
  const ruta = join(CARPETA, nombre)
  const salida = spawnSync(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, ruta], { windowsHide: true })
  assert.equal(salida.status, 0, `ffmpeg no pudo generar ${nombre}: ${salida.stderr}`)
  return ruta
}

const tono = (segundos: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`]

// El transcriptor falso: contesta el protocolo de transcriptor/transcribir.mjs sin ningún modelo.
const TRANSCRIPTOR_FALSO = `
import { appendFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'

const modo = process.env.MODO_FALSO ?? 'normal'
const anotar = (linea) => appendFileSync(process.env.BITACORA_FALSA, linea + '\\n')
const escribir = (mensaje) => new Promise((listo) => process.stdout.write(JSON.stringify(mensaje) + '\\n', listo))

anotar('arranque')
if (modo === 'sin-modelo') {
  await escribir({ listo: false, error: 'no está el modelo de prueba' })
  process.exit(1)
}
// Una biblioteca que imprime por su cuenta: no puede romperle la lectura a quien lanzó el proceso.
process.stdout.write('cargando pesos...\\n')
await escribir({ listo: true, modelo: process.env.MODELO_TRANSCRIPCION })

for await (const linea of createInterface({ input: process.stdin })) {
  const pedido = JSON.parse(linea)
  anotar('pedido')
  if (modo === 'caida') process.exit(3)
  if (modo === 'error') {
    await escribir({ id: pedido.id, error: 'audio imposible' })
    continue
  }
  await escribir({ progreso: 50 })
  const textos = {
    bucle: 'gracias '.repeat(12) + 'por llamar',
    creditos: '... Subtítulos por la comunidad de Amara.org',
    'creditos-al-final': 'Las de cuero salen 80 mil. Subtítulos realizados por la comunidad de Amara.org',
  }
  const texto = textos[modo] ?? 'escuché ' + statSync(pedido.pcm).size + ' bytes ⟪sin corchetes⟫'
  await escribir({ id: pedido.id, texto })
}
`

const BITACORA = join(CARPETA, 'bitacora.txt')
const carpetaDelFalso = mkdtempSync(join(CARPETA, 'transcriptor-'))
writeFileSync(join(carpetaDelFalso, 'transcribir.mjs'), TRANSCRIPTOR_FALSO)
writeFileSync(BITACORA, '')
process.env.RUTA_TRANSCRIPTOR = join(carpetaDelFalso, 'transcribir.mjs')
process.env.BITACORA_FALSA = BITACORA
process.env.DIR_MODELOS = join(CARPETA, 'modelos')
process.env.MODELO_TRANSCRIPCION = 'whisper-base'

const bitacora = () => readFileSync(BITACORA, 'utf8').split('\n').filter(Boolean)

/** Cierra el transcriptor que haya y deja todo listo para lanzar otro en el modo pedido. */
async function enModo(modo: string): Promise<void> {
  await cerrarTranscriptor()
  process.env.MODO_FALSO = modo
  writeFileSync(BITACORA, '')
}

after(async () => {
  // Sin esto el proceso de la prueba quedaría esperando al hijo hasta que se cierre solo.
  await cerrarTranscriptor()
})

const rechazaCon = (causa: ErrorMultimedia['causa'], mensaje?: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ErrorMultimedia, `se esperaba ErrorMultimedia y llegó ${err}`)
  assert.equal(err.causa, causa, err.message)
  if (mensaje) assert.match(err.message, mensaje)
  return true
}

describe('funciones puras', () => {
  it('cuantosFotogramas: 4 hasta 20 s, 6 hasta un minuto, 8 si dura más', () => {
    assert.deepEqual([0, 5, 20, 20.1, 47, 60, 61, 3600].map(cuantosFotogramas), [4, 4, 4, 6, 6, 6, 8, 8])
  })

  it('tieneVoz distingue un tono del silencio y del ruido de fondo', () => {
    const silencio = new Float32Array(16_000 * 3)
    const ruido = Float32Array.from({ length: 16_000 * 3 }, (_, i) => 0.002 * Math.sin(i))
    const voz = Float32Array.from({ length: 16_000 * 3 }, (_, i) => (i > 20_000 && i < 30_000 ? 0.3 * Math.sin(i / 5) : 0))
    assert.equal(tieneVoz(silencio), false)
    assert.equal(tieneVoz(ruido), false)
    assert.equal(tieneVoz(voz), true)
    assert.equal(tieneVoz(new Float32Array(0)), false)
  })

  it('hayBucle detecta una secuencia de 1 a 8 palabras repetida 5 veces o más', () => {
    assert.equal(hayBucle('gracias gracias gracias gracias gracias'), true)
    assert.equal(hayBucle('Hola. y el precio, y el precio, y el precio, y el precio, Y EL PRECIO queda así'), true)
    assert.equal(hayBucle('uno dos tres cuatro cinco seis siete ocho '.repeat(5)), true)
    // Cuatro veces no alcanza, y repetir una palabra a propósito tampoco.
    assert.equal(hayBucle('no no no no, eso no'), false)
    assert.equal(hayBucle('confeccionamos fundas, confeccionamos cubrevolantes y confeccionamos alfombras'), false)
    assert.equal(hayBucle(''), false)
  })

  it('colapsarBucles deja dos repeticiones y no toca lo demás', () => {
    assert.equal(colapsarBucles('hola gracias gracias gracias gracias gracias gracias por llamar'), 'hola gracias gracias por llamar')
    assert.equal(colapsarBucles('y el precio y el precio y el precio y el precio y el precio final'), 'y el precio y el precio final')
    assert.equal(colapsarBucles('Las de cuero ecológico salen 80 mil de lista.'), 'Las de cuero ecológico salen 80 mil de lista.')
    assert.equal(hayBucle(colapsarBucles('si '.repeat(40))), false)
  })

  it('quitarCreditosInventados saca el crédito de subtítulos que Whisper inventa y nada más', () => {
    assert.equal(quitarCreditosInventados('... Subtítulos por la comunidad de Amara.org'), '...')
    assert.equal(quitarCreditosInventados('Subtítulos realizados por la comunidad de Amara.org'), '')
    assert.equal(quitarCreditosInventados('Te paso el precio. Subtitulos en español de Amara.org. Avisame.'), 'Te paso el precio. Avisame.')
    // Lo que sí puede decir alguien queda tal cual.
    assert.equal(quitarCreditosInventados('El video tiene subtítulos, por si no lo podés escuchar.'), 'El video tiene subtítulos, por si no lo podés escuchar.')
    assert.equal(quitarCreditosInventados('Las de cuero ecológico salen 80 mil de lista.'), 'Las de cuero ecológico salen 80 mil de lista.')
  })

  it('leerDuracion y leerPistas entienden lo que imprime ffmpeg', () => {
    const video = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'entrada':
  Duration: 00:01:08.25, start: 0.000000, bitrate: 1711 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 576x1024 [SAR 1:1 DAR 9:16], 1666 kb/s, 30 fps, 30 tbr (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 47 kb/s (default)`
    assert.equal(leerDuracion(video), 68.25)
    assert.deepEqual(leerPistas(video), { video: true, audio: true, ancho: 576, alto: 1024 })

    const audio = `Input #0, ogg, from 'entrada':\r\n  Duration: 01:00:13.50, start: 0.006500, bitrate: 25 kb/s\r\n  Stream #0:0: Audio: opus, 48000 Hz, mono, fltp\r\n`
    assert.equal(leerDuracion(audio), 3613.5)
    assert.deepEqual(leerPistas(audio), { video: false, audio: true, ancho: 0, alto: 0 })

    // La tapa de un disco figura como video, pero no es un video.
    const conTapa = `  Duration: N/A, bitrate: N/A
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr (attached pic)`
    assert.equal(leerDuracion(conTapa), null)
    assert.deepEqual(leerPistas(conTapa), { video: false, audio: true, ancho: 0, alto: 0 })
    assert.deepEqual(leerPistas('entrada: Invalid data found when processing input'), { video: false, audio: false, ancho: 0, alto: 0 })
  })

  it('el modelo se puede forzar; si no, se elige solo según la memoria', () => {
    assert.equal(modeloDeTranscripcion(), 'whisper-base')
    const forzado = process.env.MODELO_TRANSCRIPCION
    try {
      process.env.MODELO_TRANSCRIPCION = 'cualquier-cosa'
      assert.ok(['whisper-small', 'whisper-base'].includes(modeloDeTranscripcion()))
    } finally {
      process.env.MODELO_TRANSCRIPCION = forzado
    }
  })
})

describe('imagenParaClaude', () => {
  function png(ancho: number, alto: number): Buffer {
    const datos = Buffer.alloc(40)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(datos)
    datos.write('IHDR', 12, 'latin1')
    datos.writeUInt32BE(ancho, 16)
    datos.writeUInt32BE(alto, 20)
    return datos
  }

  it('una imagen que Claude ya acepta va tal cual, sin pasar por ffmpeg', async () => {
    const ruta = join(CARPETA, 'captura.png')
    writeFileSync(ruta, png(1290, 2796))
    const imagen = await imagenParaClaude(ruta, 'image/png')
    assert.equal(imagen.mime, 'image/png')
    assert.deepEqual(imagen.datos, png(1290, 2796))
  })

  it('una captura de más de 8000 px se achica a un JPEG que sí acepta', { skip: sinFfmpeg }, async () => {
    const ruta = generar('larga.png', ['-f', 'lavfi', '-i', 'color=c=red:s=9000x10', '-frames:v', '1'])
    assert.deepEqual(ladosDeImagen(readFileSync(ruta), 'image/png'), [9000, 10])
    const imagen = await imagenParaClaude(ruta, 'image/png')
    assert.equal(imagen.mime, 'image/jpeg')
    const lados = ladosDeImagen(imagen.datos, 'image/jpeg')
    assert.ok(lados && lados[0] === 1568 && lados[1] <= 10, `quedó de ${lados}`)
  })

  it('un BMP, que Claude no recibe, se convierte', { skip: sinFfmpeg }, async () => {
    const ruta = generar('logo.bmp', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1'])
    const imagen = await imagenParaClaude(ruta, 'image/bmp')
    assert.equal(imagen.mime, 'image/jpeg')
    assert.deepEqual(ladosDeImagen(imagen.datos, 'image/jpeg'), [64, 48])
  })

  it('lo que dice ser una imagen y no lo es, falla como ilegible', { skip: sinFfmpeg }, async () => {
    const ruta = join(CARPETA, 'rota.heic')
    writeFileSync(ruta, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(200, 9)]))
    await assert.rejects(imagenParaClaude(ruta, 'image/heic'), rechazaCon('ilegible'))
  })
})

describe('ffmpeg solo abre el archivo', () => {
  it('una lista de reproducción renombrada a .mp4 no hace ningún pedido a la red', async () => {
    let pedidos = 0
    const servidor = createServer((_req, res) => {
      pedidos++
      res.end('no tendría que llegar nada')
    })
    await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo))
    const { port } = servidor.address() as AddressInfo
    try {
      const lista = join(CARPETA, 'video.mp4')
      writeFileSync(lista, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${port}/interno.ts\n#EXT-X-ENDLIST\n`)
      const concat = join(CARPETA, 'lista.mp4')
      writeFileSync(concat, `ffconcat version 1.0\nfile 'http://127.0.0.1:${port}/otro.mp4'\n`)
      for (const ruta of [lista, concat]) {
        // Sin la firma de un video ni llega a ffmpeg: esté o no instalado, falla igual.
        await assert.rejects(analizar(ruta), rechazaCon('ilegible', /firma/))
        await assert.rejects(fotogramasDeVideo(ruta), rechazaCon('ilegible'))
        await assert.rejects(transcribirAudio(ruta, { dirCache: join(CARPETA, 'cache-red') }), rechazaCon('ilegible'))
        await assert.rejects(imagenParaClaude(ruta, 'image/heic'), rechazaCon('ilegible'))
      }
      assert.equal(pedidos, 0)
    } finally {
      await new Promise((listo) => servidor.close(listo))
    }
  })

  it('con la firma de un video y una lista adentro, el formato forzado tampoco la sigue', { skip: sinFfmpeg }, async () => {
    let pedidos = 0
    const servidor = createServer((_req, res) => {
      pedidos++
      res.end()
    })
    await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo))
    const { port } = servidor.address() as AddressInfo
    try {
      // Empieza como un Matroska y sigue como una lista: ffmpeg lo abre como Matroska o no lo abre.
      const ruta = join(CARPETA, 'disfrazado.webm')
      writeFileSync(ruta, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`\n#EXTM3U\n#EXTINF:10,\nhttp://127.0.0.1:${port}/interno.ts\n`)]))
      await assert.rejects(analizar(ruta), rechazaCon('ilegible'))
      assert.equal(pedidos, 0)
    } finally {
      await new Promise((listo) => servidor.close(listo))
    }
  })

  it('un archivo que no está avisa que se perdió, no que falta ffmpeg', async () => {
    await assert.rejects(analizar(join(CARPETA, 'no-existe.mp4')), (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT')
  })
})

describe('video', () => {
  it('analiza un video corto y saca cuatro fotogramas parejos', { skip: sinFfmpeg }, async () => {
    const ruta = generar('corto.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10', ...tono(5), '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest'])
    const analisis = await analizar(ruta)
    assert.deepEqual([analisis.video, analisis.audio, analisis.ancho, analisis.alto], [true, true, 320, 240])
    assert.ok(Math.abs(analisis.segundos - 5) < 0.5, `dura ${analisis.segundos}`)

    const fotogramas = await fotogramasDeVideo(ruta)
    assert.deepEqual([fotogramas.tieneVideo, fotogramas.tieneAudio, fotogramas.cuadros.length], [true, true, 4])
    for (const cuadro of fotogramas.cuadros) assert.deepEqual(ladosDeImagen(cuadro, 'image/jpeg'), [320, 240])
    // Parejos a lo largo del video: no son cuatro veces el mismo cuadro.
    assert.equal(new Set(fotogramas.cuadros.map((c) => c.toString('base64'))).size, 4)
  })

  it('un video largo y en alta resolución se recorre a saltos, sin decodificarlo entero', { skip: sinFfmpeg }, async () => {
    const ruta = generar('largo.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=70:size=2560x1440:rate=2', '-c:v', 'mpeg4', '-g', '4'])
    const inicio = Date.now()
    const fotogramas = await fotogramasDeVideo(ruta)
    assert.deepEqual([fotogramas.tieneVideo, fotogramas.tieneAudio, fotogramas.cuadros.length], [true, false, 8])
    // Achicados a 1024 de lado como mucho.
    for (const cuadro of fotogramas.cuadros) assert.deepEqual(ladosDeImagen(cuadro, 'image/jpeg'), [1024, 576])
    assert.equal(new Set(fotogramas.cuadros.map((c) => c.toString('base64'))).size, 8)
    assert.ok(Date.now() - inicio < 60_000)
  })

  it('un audio no tiene fotogramas: el motor lo trata como audio', { skip: sinFfmpeg }, async () => {
    const ruta = generar('solo-audio.wav', [...tono(2), '-c:a', 'pcm_s16le'])
    assert.deepEqual(await fotogramasDeVideo(ruta), { cuadros: [], segundos: 2, tieneVideo: false, tieneAudio: true })
  })
})

describe('el transcriptor', () => {
  it('responde la prueba de arranque, aunque una biblioteca escriba por su cuenta en la salida', async () => {
    await enModo('normal')
    assert.deepEqual(await probarTranscriptor(), { ok: true, detalle: 'ok' })
    // El mismo proceso atiende el pedido siguiente: no se carga el modelo de nuevo.
    assert.deepEqual(await probarTranscriptor(), { ok: true, detalle: 'ok' })
    assert.deepEqual(bitacora(), ['arranque', 'pedido', 'pedido'])
  })

  it('si no puede cargar el modelo, dice por qué y queda a la vista en la salud', async () => {
    await enModo('sin-modelo')
    const prueba = await probarTranscriptor()
    assert.equal(prueba.ok, false)
    assert.match(prueba.detalle, /no está el modelo de prueba/)

    olvidarEstadoMultimedia()
    const salud = await estadoMultimedia()
    assert.equal(salud.ok, false)
    // En la carpeta de prueba no hay modelo ni dependencias: cada campo dice qué falta.
    assert.match(salud.transcriptor, /npm install/)
    assert.match(salud.modelo, /Falta el modelo whisper-base.*npm run modelo/)
    assert.ok(salud.ffmpeg === 'ok' || /RUTA_FFMPEG/.test(salud.ffmpeg))
  })

  it('si el proceso se cae con un pedido, prueba una vez más con uno nuevo antes de darlo por perdido', async () => {
    await enModo('caida')
    const prueba = await probarTranscriptor()
    assert.equal(prueba.ok, false)
    assert.match(prueba.detalle, /terminó con código 3/)
    assert.deepEqual(bitacora(), ['arranque', 'pedido', 'arranque', 'pedido'])
  })

  it('si falta el archivo del transcriptor, avisa qué revisar', async () => {
    await enModo('normal')
    const ruta = process.env.RUTA_TRANSCRIPTOR
    try {
      process.env.RUTA_TRANSCRIPTOR = join(CARPETA, 'no-existe', 'transcribir.mjs')
      const prueba = await probarTranscriptor()
      assert.equal(prueba.ok, false)
      olvidarEstadoMultimedia()
      assert.match((await estadoMultimedia()).transcriptor, /RUTA_TRANSCRIPTOR/)
    } finally {
      process.env.RUTA_TRANSCRIPTOR = ruta
      olvidarEstadoMultimedia()
    }
  })
})

describe('transcribirAudio', () => {
  const cache = () => mkdtempSync(join(CARPETA, 'cache-'))

  it('transcribe un audio, guarda el resultado y no lo hace dos veces', { skip: sinFfmpeg }, async () => {
    await enModo('normal')
    const ruta = generar('tono.wav', [...tono(3), '-c:a', 'pcm_s16le'])
    const dirCache = cache()
    // Dos pedidos a la vez del mismo archivo (la subida lo adelanta y la persona toca «Seguir»): un solo trabajo.
    const [primera, segunda] = await Promise.all([transcribirAudio(ruta, { hash: 'tono', dirCache }), transcribirAudio(ruta, { hash: 'tono', dirCache })])
    // 3 segundos a 16 kHz en float32 son unos 192.000 bytes. Los corchetes dobles se sacan: los pone la app.
    assert.match(primera.texto, /^escuché 19\d{4} bytes sin corchetes$/)
    assert.deepEqual({ ...primera, texto: '' }, { texto: '', segundos: 3, sinVoz: false, dudosa: false, recortada: false })
    assert.deepEqual(segunda, primera)
    assert.deepEqual(readdirSync(dirCache), ['tono.whisper-base.json'])
    assert.equal(transcripcionPendiente(dirCache, 'tono'), false)

    // La próxima vez sale de la caché, sin lanzar nada.
    assert.deepEqual(await transcribirAudio(ruta, { hash: 'tono', dirCache }), primera)
    assert.deepEqual(bitacora(), ['arranque', 'pedido'])
    // Sin hash lo calcula del archivo.
    const otra = cache()
    await transcribirAudio(ruta, { dirCache: otra })
    assert.match(readdirSync(otra)[0], /^[0-9a-f]{64}\.whisper-base\.json$/)
  })

  it('el silencio no se manda a transcribir: Whisper inventaría palabras', { skip: sinFfmpeg }, async () => {
    await enModo('normal')
    const ruta = generar('silencio.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le'])
    assert.deepEqual(await transcribirAudio(ruta, { dirCache: cache() }), { texto: '', segundos: 3, sinVoz: true, dudosa: false, recortada: false })
    assert.deepEqual(bitacora(), [])
  })

  it('saca el audio de un video, y un video mudo da «sin voz»', { skip: sinFfmpeg }, async () => {
    await enModo('normal')
    const conAudio = generar('hablado.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5', ...tono(2), '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest'])
    const escuchado = await transcribirAudio(conAudio, { dirCache: cache() })
    assert.match(escuchado.texto, /^escuché \d+ bytes/)
    const mudo = generar('mudo.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5', '-c:v', 'mpeg4'])
    assert.deepEqual(await transcribirAudio(mudo, { dirCache: cache() }), { texto: '', segundos: 2, sinVoz: true, dudosa: false, recortada: false })
  })

  it('una transcripción en bucle queda marcada como dudosa y sin la repetición', { skip: sinFfmpeg }, async () => {
    await enModo('bucle')
    const ruta = generar('enganchado.wav', [...tono(2), '-c:a', 'pcm_s16le'])
    const transcripcion = await transcribirAudio(ruta, { dirCache: cache() })
    assert.deepEqual([transcripcion.texto, transcripcion.dudosa], ['gracias gracias por llamar', true])
  })

  it('un audio donde no habla nadie no deja el crédito de subtítulos que inventa Whisper', { skip: sinFfmpeg }, async () => {
    await enModo('creditos')
    const soloTono = generar('solo-tono.wav', [...tono(2), '-c:a', 'pcm_s16le'])
    assert.deepEqual(await transcribirAudio(soloTono, { dirCache: cache() }), { texto: '', segundos: 2, sinVoz: true, dudosa: false, recortada: false })

    // Si además se dijo algo, eso queda, sin el crédito y avisando que puede tener errores.
    await enModo('creditos-al-final')
    const conCredito = generar('con-credito.wav', [...tono(3), '-c:a', 'pcm_s16le'])
    const transcripcion = await transcribirAudio(conCredito, { dirCache: cache() })
    assert.deepEqual([transcripcion.texto, transcripcion.sinVoz, transcripcion.dudosa], ['Las de cuero salen 80 mil.', false, true])
  })

  it('un audio que el transcriptor no puede leer falla una vez y no se reintenta en cada «Seguir»', { skip: sinFfmpeg }, async () => {
    await enModo('error')
    const ruta = generar('imposible.wav', [...tono(2), '-c:a', 'pcm_s16le'])
    const dirCache = cache()
    await assert.rejects(transcribirAudio(ruta, { hash: 'imposible', dirCache }), rechazaCon('ilegible', /audio imposible/))
    await assert.rejects(transcribirAudio(ruta, { hash: 'imposible', dirCache }), rechazaCon('ilegible'))
    assert.deepEqual(bitacora(), ['arranque', 'pedido'])
    assert.deepEqual(existsSync(dirCache) ? readdirSync(dirCache) : [], [])
    assert.equal(transcripcionPendiente(dirCache, 'imposible'), false)
  })

  it('si lo que falla es el transcriptor y no el audio, se vuelve a intentar cuando ande', { skip: sinFfmpeg }, async () => {
    await enModo('sin-modelo')
    const ruta = generar('despues.wav', [...tono(2), '-c:a', 'pcm_s16le'])
    const dirCache = cache()
    await assert.rejects(transcribirAudio(ruta, { hash: 'despues', dirCache }), rechazaCon('sin_herramienta', /no está el modelo de prueba/))
    await enModo('normal')
    assert.match((await transcribirAudio(ruta, { hash: 'despues', dirCache })).texto, /^escuché/)
  })

  it('un archivo con firma de audio y basura adentro es ilegible', { skip: sinFfmpeg }, async () => {
    const ruta = join(CARPETA, 'basura.opus')
    writeFileSync(ruta, Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2]), Buffer.alloc(500, 7)]))
    await assert.rejects(transcribirAudio(ruta, { dirCache: cache() }), rechazaCon('ilegible'))
  })
})
