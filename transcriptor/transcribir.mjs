// Proceso hijo que transcribe audio con Whisper. La app nunca lo importa: lo lanza
// lib/multimedia.ts con process.execPath, para que Next no empaquete onnxruntime ni sharp y para
// que la memoria del modelo (cerca de 1 GB) se devuelva entera cuando el proceso termina.
//
// Protocolo, una línea JSON por mensaje:
//   al arrancar, por stdout:  {"listo":true,"modelo":"whisper-small"}  o  {"listo":false,"error":"…"} y sale con 1
//   pedido, por stdin:        {"id":"…","pcm":"<ruta a PCM float32 LE mono 16 kHz>","segundos":<n>}
//   respuesta, por stdout:    {"id":"…","texto":"…"}  o  {"id":"…","error":"…"}
// Los pedidos se atienden de a uno y en orden. Termina cuando se cierra stdin.
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

// stdout es solo para el protocolo. El logger de transformers escribe info y debug con
// console.log, y una línea suelta ahí le rompería la lectura a quien lanzó este proceso.
console.log = console.info = console.debug = console.error

const MODELOS = {
  // El encoder cuantizado de small no dio bucles de repetición en las mediciones; el de base sí,
  // por eso base usa el encoder entero.
  'whisper-small': 'q8',
  'whisper-base': { encoder_model: 'fp32', decoder_model_merged: 'q8' },
}
const FRECUENCIA = 16000
const BYTES_POR_MUESTRA = 4
// Por debajo de esto el pico de whisper-small (cerca de 1 GB) no deja lugar para Next y Postgres.
const MEMORIA_MINIMA_PARA_SMALL = 3 * 1024 ** 3

function responder(mensaje) {
  return new Promise((listo) => process.stdout.write(`${JSON.stringify(mensaje)}\n`, () => listo()))
}

function detalle(error) {
  return error instanceof Error ? error.message : String(error)
}

// Si quien lanzó el proceso ya no lee, no queda nadie a quien contestarle.
process.stdout.on('error', () => process.exit(0))

/** La memoria que de verdad puede usar el proceso: el límite del contenedor si lo hay, o la de la máquina. */
function memoriaDisponible() {
  let memoria = totalmem()
  // cgroup v2 y v1. Sin límite dicen 'max' o un número enorme: en los dos casos gana totalmem.
  for (const ruta of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const limite = Number(readFileSync(ruta, 'utf8').trim())
      if (Number.isFinite(limite) && limite > 0) memoria = Math.min(memoria, limite)
    } catch {
      // No es Linux o no hay cgroup: vale la memoria total.
    }
  }
  return memoria
}

function elegirModelo() {
  const pedido = (process.env.MODELO_TRANSCRIPCION ?? '').trim()
  if (pedido) {
    if (!Object.hasOwn(MODELOS, pedido)) {
      throw new Error(
        `MODELO_TRANSCRIPCION vale «${pedido}» y solo puede ser whisper-small o whisper-base. Corregila o dejala vacía.`,
      )
    }
    return pedido
  }
  return memoriaDisponible() < MEMORIA_MINIMA_PARA_SMALL ? 'whisper-base' : 'whisper-small'
}

function elegirHilos() {
  const pedido = (process.env.HILOS_TRANSCRIPCION ?? '').trim()
  if (pedido) {
    const hilos = Number(pedido)
    if (!Number.isInteger(hilos) || hilos < 1 || hilos > 64) {
      throw new Error(
        `HILOS_TRANSCRIPCION vale «${pedido}» y tiene que ser un número entero de 1 a 64. Corregila o dejala vacía.`,
      )
    }
    return hilos
  }
  // Más de 2 hilos casi no acelera (manda el decoder, que va token por token), y en un servidor
  // de 2 núcleos hay que dejarle uno a la app mientras alguien sube archivos.
  return Math.min(2, Math.max(1, availableParallelism() - 1))
}

/** Carpeta de modelos, con la barra final que pide transformers. */
function carpetaDeModelos(modelo) {
  const pedida = (process.env.DIR_MODELOS ?? '').trim()
  if (!pedida) throw new Error('Falta DIR_MODELOS: es la carpeta donde están los modelos de Whisper.')
  // Una ruta relativa se escribió pensando en la carpeta de la app, y este proceso corre parado
  // en transcriptor/: se prueba también contra la carpeta de arriba.
  const candidatas = isAbsolute(pedida)
    ? [pedida]
    : [resolve(pedida), resolve(dirname(import.meta.dirname), pedida)]
  const carpeta = candidatas.find((c) => existsSync(join(c, 'onnx-community', modelo, 'config.json')))
  if (!carpeta) {
    throw new Error(
      `No está el modelo ${modelo} en ${candidatas.join(' ni en ')}. En local, corré ` +
        `«node scripts/bajar-modelo.mjs data/modelos ${modelo}». En el servidor, revisá DIR_MODELOS: ` +
        'la imagen lo trae en /app/modelos.',
    )
  }
  return carpeta.endsWith(sep) ? carpeta : carpeta + sep
}

async function cargar() {
  const modelo = elegirModelo()
  const hilos = elegirHilos()
  const carpeta = carpetaDeModelos(modelo)

  // Import dinámico: si onnxruntime o sharp no cargan (otra libc, un binario que falta), el
  // error llega acá y sale por el protocolo en vez de matar el proceso sin explicación.
  const { pipeline, env, LogLevel } = await import('@huggingface/transformers')
  env.logLevel = LogLevel.ERROR
  env.localModelPath = carpeta
  env.allowLocalModels = true
  // Nunca se baja nada al transcribir: si el modelo falta, tiene que verse como error.
  env.allowRemoteModels = false
  // En la imagen los modelos y node_modules son de root y este proceso corre como otro usuario:
  // no puede, ni necesita, escribir ninguna caché.
  env.useFSCache = false
  env.useWasmCache = false

  const asr = await pipeline('automatic-speech-recognition', `onnx-community/${modelo}`, {
    dtype: MODELOS[modelo],
    device: 'cpu',
    // Sin arena de memoria el pico baja unos 300 MB a cambio de ser algo más lento.
    session_options: { intraOpNumThreads: hilos, interOpNumThreads: 1, enableCpuMemArena: false },
  })
  console.error(`[transcriptor] ${modelo} cargado con ${hilos} hilo(s) desde ${carpeta}`)
  return { asr, modelo }
}

async function leerPcm(ruta) {
  const datos = await readFile(ruta)
  const bytes = datos.byteLength - (datos.byteLength % BYTES_POR_MUESTRA)
  if (bytes === 0) throw new Error('El audio decodificado está vacío.')
  // El Buffer de Node puede ser una vista a mitad de un ArrayBuffer compartido, sin alinear a
  // 4 bytes: Float32Array lo rechazaría. Se copia a un ArrayBuffer propio.
  const propio = new ArrayBuffer(bytes)
  new Uint8Array(propio).set(datos.subarray(0, bytes))
  return new Float32Array(propio)
}

async function transcribir(asr, pedido) {
  const pcm = await leerPcm(pedido.pcm)
  const segundos =
    typeof pedido.segundos === 'number' && Number.isFinite(pedido.segundos) && pedido.segundos > 0
      ? pedido.segundos
      : pcm.length / FRECUENCIA
  const salida = await asr(pcm, {
    language: 'spanish',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    // Con más de una ventana de 30 s, sin marcas de tiempo las ventanas se pegan mal.
    return_timestamps: segundos > 30,
    // Red de seguridad contra los bucles de repetición. Con 8 no cambia el texto de small; con
    // menos, rompe palabras que se repiten a propósito.
    no_repeat_ngram_size: 8,
  })
  const texto = Array.isArray(salida) ? salida.map((parte) => parte.text).join(' ') : salida.text
  return String(texto ?? '').trim()
}

async function atender(asr, linea) {
  let pedido
  try {
    pedido = JSON.parse(linea)
  } catch {
    console.error('[transcriptor] Se ignoró una línea de stdin que no es JSON.')
    return
  }
  if (!pedido || typeof pedido !== 'object' || typeof pedido.id !== 'string') {
    console.error('[transcriptor] Se ignoró un pedido sin «id»: no hay a quién contestarle.')
    return
  }
  const { id } = pedido
  if (typeof pedido.pcm !== 'string' || !pedido.pcm) {
    await responder({ id, error: 'El pedido no trae «pcm», la ruta al audio decodificado.' })
    return
  }
  const inicio = performance.now()
  try {
    const texto = await transcribir(asr, pedido)
    await responder({ id, texto })
    console.error(`[transcriptor] ${id}: ${Math.round(performance.now() - inicio)} ms`)
  } catch (error) {
    await responder({ id, error: detalle(error) })
    console.error(`[transcriptor] ${id} falló: ${detalle(error)}`)
  }
}

let asr
try {
  const cargado = await cargar()
  asr = cargado.asr
  await responder({ listo: true, modelo: cargado.modelo })
} catch (error) {
  console.error(`[transcriptor] No pudo arrancar: ${detalle(error)}`)
  await responder({ listo: false, error: detalle(error) })
  process.exit(1)
}

// Una sola cadena de promesas: cada pedido empieza cuando terminó el anterior, así nunca hay
// dos transcripciones a la vez y las respuestas salen en el orden en que llegaron los pedidos.
let cola = Promise.resolve()
const lineas = createInterface({ input: process.stdin, crlfDelay: Infinity })
lineas.on('line', (linea) => {
  if (!linea.trim()) return
  cola = cola.then(() => atender(asr, linea))
})
lineas.on('close', () => {
  // Se termina lo que ya llegó y recién después se sale: onnxruntime puede dejar hilos vivos,
  // así que la salida es explícita.
  cola.then(() => process.exit(0))
})
