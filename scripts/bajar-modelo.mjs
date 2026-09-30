// Baja los modelos de Whisper que usa transcriptor/transcribir.mjs.
//
//   node scripts/bajar-modelo.mjs <destino> [whisper-small|whisper-base|todos]
//
// En local lo corre «npm run modelo» (deja whisper-small en data/modelos). En la imagen lo corre
// una etapa del Dockerfile con «todos»: si Hugging Face no responde, falla el build, que se ve,
// y no el cuestionario de un cliente.
//
// Sin dependencias: fetch, crypto y fs de Node.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// La revisión fija el contenido: sin ella el modelo podría cambiar sin aviso. Cada archivo lleva
// además su huella, para que un archivo cortado o cambiado en el camino no llegue a la imagen.
// `huella` es el sha256 del contenido (64 caracteres) o, en los archivos chicos que Hugging Face
// guarda en git, el sha1 del objeto de git (40). `bytes` va solo en los grandes: sirve para
// mostrar el avance y para retomar una descarga cortada.
const MODELOS = {
  'whisper-small': {
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    archivos: [
      { ruta: 'config.json', huella: 'b0447377b1ade057f991a6a0870d2a91de762f7f' },
      { ruta: 'generation_config.json', huella: '703dc78ee83e87fca3ace72170253cdfe4cd2d13' },
      { ruta: 'preprocessor_config.json', huella: '91876762a536a746d268353c5cba57286e76b058' },
      { ruta: 'tokenizer.json', huella: '1e95340ff836fad1b5932e800fb7b8c5e6d78a74' },
      { ruta: 'tokenizer_config.json', huella: 'd13b786c04765fb1a06492b53587752cd67665ea' },
      {
        ruta: 'onnx/encoder_model_quantized.onnx',
        huella: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92',
        bytes: 92326160,
      },
      {
        ruta: 'onnx/decoder_model_merged_quantized.onnx',
        huella: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9',
        bytes: 156750845,
      },
    ],
  },
  'whisper-base': {
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    archivos: [
      { ruta: 'config.json', huella: 'ce7faf5d5e56e82d4800e55f524582a525639ff7' },
      { ruta: 'generation_config.json', huella: 'a57cdbf036979f80bb7ff092a0fee6256a81d329' },
      { ruta: 'preprocessor_config.json', huella: '91876762a536a746d268353c5cba57286e76b058' },
      { ruta: 'tokenizer.json', huella: '1e95340ff836fad1b5932e800fb7b8c5e6d78a74' },
      { ruta: 'tokenizer_config.json', huella: '25be523be5ac50a7671a77f55acba082459d6314' },
      {
        // Entero y no cuantizado: el encoder cuantizado de base entra en bucles de repetición.
        ruta: 'onnx/encoder_model.onnx',
        huella: 'a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe',
        bytes: 82468078,
      },
      {
        ruta: 'onnx/decoder_model_merged_quantized.onnx',
        huella: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
        bytes: 53693315,
      },
    ],
  },
}

const INTENTOS = 4 // el primero y 3 reintentos
// Una descarga que deja de mandar datos no puede colgar el build para siempre.
const SEGUNDOS_SIN_DATOS = 60
const MB = 1024 * 1024

const mb = (bytes) => (bytes / MB).toFixed(1).replace('.', ',')
const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms))

/** Lo bajado no sirve (huella distinta o bytes de más): hay que tirarlo y empezar de cero, no retomarlo. */
class ErrorDeContenido extends Error {}

/** sha256 del contenido, o sha1 del objeto de git («blob <largo>\0» + contenido), según el largo de la huella pedida. */
async function huellaDe(ruta, largo) {
  const resumen = createHash(largo === 40 ? 'sha1' : 'sha256')
  if (largo === 40) resumen.update(`blob ${(await stat(ruta)).size}\0`)
  for await (const parte of createReadStream(ruta)) resumen.update(parte)
  return resumen.digest('hex')
}

async function estaCompleto(ruta, archivo) {
  try {
    const { size } = await stat(ruta)
    if (archivo.bytes !== undefined && size !== archivo.bytes) return false
    return (await huellaDe(ruta, archivo.huella.length)) === archivo.huella
  } catch {
    return false
  }
}

/**
 * Cuánto quedó de una descarga anterior que se cortó. Solo se retoma un archivo grande: de los
 * chicos no se sabe el tamaño de antemano y bajan en un segundo.
 */
async function yaBajado(temporal, archivo) {
  if (archivo.bytes === undefined) return 0
  try {
    const { size } = await stat(temporal)
    return size <= archivo.bytes ? size : 0
  } catch {
    return 0
  }
}

/** Baja a `temporal`, siguiendo desde el byte `desde` si el servidor lo acepta. Devuelve cuántos bytes tiene el archivo al terminar. */
async function descargar(url, temporal, archivo, etiqueta, desde) {
  const corte = new AbortController()
  let reloj = setTimeout(() => corte.abort(), SEGUNDOS_SIN_DATOS * 1000)
  try {
    // fetch sigue solo las redirecciones: Hugging Face manda cada archivo a su CDN.
    const respuesta = await fetch(url, {
      signal: corte.signal,
      headers: desde > 0 ? { Range: `bytes=${desde}-` } : {},
    })
    if (!respuesta.ok || !respuesta.body) {
      throw new Error(`Hugging Face respondió ${respuesta.status} ${respuesta.statusText}`.trim())
    }
    // Un 200 en vez de un 206 quiere decir que mandó el archivo entero: se empieza de nuevo.
    if (respuesta.status !== 206) desde = 0
    // Con compresión, content-length es el largo comprimido y no sirve para comparar.
    const largo = Number(respuesta.headers.get('content-length'))
    const declarado = !respuesta.headers.get('content-encoding') && largo > 0 ? desde + largo : null
    const total = archivo.bytes ?? declarado

    const salida = createWriteStream(temporal, { flags: desde > 0 ? 'a' : 'w' })
    let fallaDeDisco = null
    salida.on('error', (error) => {
      fallaDeDisco = error
    })
    let recibidos = desde
    let proximoAviso = total ? Math.floor((recibidos / total) * 10) * 10 + 10 : 10
    if (desde > 0) console.log(`  ${etiqueta}: sigue desde ${mb(desde)} MB`)
    try {
      for await (const parte of respuesta.body) {
        if (fallaDeDisco) throw fallaDeDisco
        clearTimeout(reloj)
        reloj = setTimeout(() => corte.abort(), SEGUNDOS_SIN_DATOS * 1000)
        recibidos += parte.byteLength
        if (!salida.write(parte)) await new Promise((listo) => salida.once('drain', listo))
        // Una línea cada 10 %: en el log de un build no hay barra que se pueda redibujar.
        if (total && total > 5 * MB && (recibidos / total) * 100 >= proximoAviso) {
          console.log(`  ${etiqueta}: ${proximoAviso} % (${mb(recibidos)} de ${mb(total)} MB)`)
          proximoAviso += 10
        }
      }
    } finally {
      await new Promise((listo) => salida.end(listo))
    }
    if (fallaDeDisco) throw fallaDeDisco
    if (declarado !== null && recibidos !== declarado) {
      throw new Error(`llegaron ${recibidos} bytes y tenían que ser ${declarado}: la descarga se cortó`)
    }
    return recibidos
  } catch (error) {
    if (corte.signal.aborted) throw new Error(`no llegaron datos durante ${SEGUNDOS_SIN_DATOS} segundos`)
    throw error
  } finally {
    clearTimeout(reloj)
  }
}

async function bajar(url, temporal, archivo, etiqueta) {
  let bytes = await yaBajado(temporal, archivo)
  // Si lo que quedó ya mide lo que tiene que medir, el corte fue justo antes de renombrar.
  if (bytes === 0 || bytes !== archivo.bytes) bytes = await descargar(url, temporal, archivo, etiqueta, bytes)

  if (archivo.bytes !== undefined && bytes !== archivo.bytes) {
    const mensaje = `llegaron ${bytes} bytes y tenían que ser ${archivo.bytes}`
    if (bytes > archivo.bytes) throw new ErrorDeContenido(`${mensaje}: el archivo cambió`)
    throw new Error(`${mensaje}: la descarga se cortó`)
  }
  const huella = await huellaDe(temporal, archivo.huella.length)
  if (huella !== archivo.huella) {
    throw new ErrorDeContenido(
      `la huella no coincide (dio ${huella} y se esperaba ${archivo.huella}): el archivo llegó dañado o cambió`,
    )
  }
  return bytes
}

async function bajarModelo(destino, nombre) {
  const { revision, archivos } = MODELOS[nombre]
  const carpeta = join(destino, 'onnx-community', nombre)
  console.log(`${nombre} (revisión ${revision.slice(0, 8)}) → ${carpeta}`)

  for (const archivo of archivos) {
    const etiqueta = `${nombre}/${archivo.ruta}`
    const final = join(carpeta, archivo.ruta)
    if (await estaCompleto(final, archivo)) {
      console.log(`  ${etiqueta}: ya estaba`)
      continue
    }
    await mkdir(dirname(final), { recursive: true })
    // Se baja con otro nombre y se renombra al terminar: un archivo con su nombre final siempre
    // está entero, aunque el proceso se corte a mitad de una descarga.
    const temporal = `${final}.tmp`
    const url = `https://huggingface.co/onnx-community/${nombre}/resolve/${revision}/${archivo.ruta}`

    let ultimo = null
    for (let intento = 1; intento <= INTENTOS; intento++) {
      try {
        const inicio = Date.now()
        const bytes = await bajar(url, temporal, archivo, etiqueta)
        await rename(temporal, final)
        const segundos = ((Date.now() - inicio) / 1000).toFixed(1).replace('.', ',')
        console.log(`  ${etiqueta}: listo (${mb(bytes)} MB en ${segundos} s)`)
        ultimo = null
        break
      } catch (error) {
        ultimo = error instanceof Error ? error : new Error(String(error))
        // Lo que se cortó por la red se guarda para seguir desde ahí. Lo que llegó mal, no.
        if (ultimo instanceof ErrorDeContenido || archivo.bytes === undefined) await rm(temporal, { force: true })
        if (intento < INTENTOS) {
          const pausa = 2 ** intento
          console.warn(`  ${etiqueta}: ${ultimo.message}. Reintento en ${pausa} s (${intento} de ${INTENTOS - 1}).`)
          await esperar(pausa * 1000)
        }
      }
    }
    if (ultimo) {
      throw new Error(
        `No se pudo bajar ${etiqueta} después de ${INTENTOS} intentos: ${ultimo.message}. ` +
          'Revisá la conexión y que https://huggingface.co responda, y corré el comando de nuevo: sigue desde donde quedó.',
      )
    }
  }
}

async function principal() {
  const [destinoPedido, cual = 'whisper-small'] = process.argv.slice(2)
  const nombres = cual === 'todos' ? Object.keys(MODELOS) : [cual]
  if (!destinoPedido || nombres.some((nombre) => !Object.hasOwn(MODELOS, nombre))) {
    console.error(
      'Uso: node scripts/bajar-modelo.mjs <destino> [whisper-small|whisper-base|todos]\n' +
        'Ejemplo: node scripts/bajar-modelo.mjs data/modelos whisper-small',
    )
    process.exit(1)
  }
  const destino = resolve(destinoPedido)
  for (const nombre of nombres) await bajarModelo(destino, nombre)
  console.log('Modelos listos.')
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
