import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { formatoFfmpeg, hashDeArchivo, ladosDeImagen } from './archivos'
import { ErrorMultimedia } from './motor/motor'
import type { Fotogramas, ImagenParaClaude, MimeImagenClaude, Transcripcion } from './motor/tipos'

/**
 * Audio, video e imágenes que Claude no recibe tal cual. Dos herramientas, las dos adentro del
 * servidor:
 *
 * - ffmpeg decodifica el audio, saca fotogramas de los videos y convierte las fotos que Claude no
 *   acepta (HEIC, demasiado grandes).
 * - El transcriptor (transcriptor/transcribir.mjs) es un proceso aparte con Whisper. Claude no
 *   recibe audio, y así no hace falta otra clave ni mandar audios de clientes a un tercero.
 *
 * Nada de esto puede frenar un cuestionario: todo lo que falla sale como ErrorMultimedia y el
 * motor deja el archivo con su nota y sigue.
 */

// ---------------------------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------------------------

type Modelo = 'whisper-small' | 'whisper-base'

function rutaFfmpeg(): string {
  return process.env.RUTA_FFMPEG?.trim() || 'ffmpeg'
}

// Las rutas que salen del entorno llevan turbopackIgnore: sin eso, el build rastrea el proyecto
// entero (el transcriptor, los modelos, los datos) para meterlo en la imagen.
function rutaTranscriptor(): string {
  const porDefecto = join(/*turbopackIgnore: true*/ process.cwd(), 'transcriptor', 'transcribir.mjs')
  return resolve(/*turbopackIgnore: true*/ process.env.RUTA_TRANSCRIPTOR?.trim() || porDefecto)
}

function dirModelos(): string {
  const datos = process.env.DIR_DATOS ?? join(/*turbopackIgnore: true*/ process.cwd(), 'data')
  return resolve(/*turbopackIgnore: true*/ process.env.DIR_MODELOS?.trim() || join(/*turbopackIgnore: true*/ datos, 'modelos'))
}

/** La memoria que de verdad puede usar el proceso: el límite del contenedor si lo hay, o la de la máquina. */
function memoriaDisponible(): number {
  let memoria = os.totalmem()
  // cgroup v2 y v1. Sin límite dicen 'max' o un número enorme: en los dos casos gana la total.
  for (const ruta of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const limite = Number(readFileSync(/*turbopackIgnore: true*/ ruta, 'utf8').trim())
      if (Number.isFinite(limite) && limite > 0) memoria = Math.min(memoria, limite)
    } catch {
      // No es Linux o no hay cgroup.
    }
  }
  return memoria
}

/**
 * whisper-small acierta precios, cuotas y modelos; whisper-base no, pero usa 300 MB menos. Con
 * menos de 3 GB se elige base sola, para que nadie tenga que acordarse de configurarlo en un
 * servidor chico. MODELO_TRANSCRIPCION lo fuerza.
 */
export function modeloDeTranscripcion(): Modelo {
  const pedido = process.env.MODELO_TRANSCRIPCION?.trim()
  if (pedido === 'whisper-small' || pedido === 'whisper-base') return pedido
  return memoriaDisponible() < 3 * 1024 ** 3 ? 'whisper-base' : 'whisper-small'
}

const ARCHIVOS_DEL_MODELO: Record<Modelo, string[]> = {
  'whisper-small': ['config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
  'whisper-base': ['config.json', 'tokenizer.json', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
}

// ---------------------------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------------------------

const SEGUNDOS_MAXIMOS_DE_AUDIO = 900
const FRECUENCIA = 16_000
const LIMITE_STDERR = 64 * 1024
const TOPE_FFMPEG_MS = 120_000

interface SalidaFfmpeg {
  codigo: number | null
  stderr: string
}

function ejecutar(args: string[], topeMs: number): Promise<SalidaFfmpeg> {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(/*turbopackIgnore: true*/ rutaFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    let vencido = false
    hijo.stderr!.setEncoding('utf8')
    hijo.stderr!.on('data', (texto: string) => {
      if (stderr.length < LIMITE_STDERR) stderr += texto
    })
    const reloj = setTimeout(() => {
      vencido = true
      hijo.kill('SIGKILL')
    }, topeMs)
    hijo.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(reloj)
      rechazar(
        new ErrorMultimedia(
          err.code === 'ENOENT' ? 'No se encontró ffmpeg: revisá RUTA_FFMPEG.' : `No se pudo lanzar ffmpeg: ${err.message}`,
          'sin_herramienta',
        ),
      )
    })
    hijo.on('close', (codigo) => {
      clearTimeout(reloj)
      if (vencido) rechazar(new ErrorMultimedia(`ffmpeg tardó más de ${Math.round(topeMs / 1000)} segundos`, 'tiempo'))
      else resolver({ codigo, stderr })
    })
  })
}

function ultimaLinea(stderr: string): string {
  return stderr.trim().split(/\r?\n/).at(-1)?.trim().slice(0, 300) || 'sin detalle'
}

/**
 * Las opciones con las que ffmpeg abre un archivo subido, siempre las mismas.
 *
 * ffmpeg decide qué es un archivo por su contenido y sigue lo que ese contenido le diga: una
 * lista de reproducción renombrada a .mp4 lo haría pedir direcciones de la red interna o leer
 * otros archivos del servidor. Por eso el formato se fuerza según la firma de los bytes y solo se
 * le permite abrir archivos. Lo que no tiene una firma conocida no llega a ffmpeg.
 */
async function entradaDe(ruta: string): Promise<string[]> {
  const archivo = await open(ruta, 'r')
  let cabecera: Buffer
  try {
    const datos = Buffer.alloc(64)
    const { bytesRead } = await archivo.read(datos, 0, 64, 0)
    cabecera = datos.subarray(0, bytesRead)
  } finally {
    await archivo.close()
  }
  const formato = formatoFfmpeg(cabecera)
  if (!formato) throw new ErrorMultimedia('no tiene la firma de un audio, un video ni una imagen', 'ilegible')
  return ['-protocol_whitelist', 'file', '-f', formato, '-i', ruta]
}

const SILENCIOSO = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y']

/** «Duration: 00:00:47.02» de lo que imprime ffmpeg. null si no la sabe. */
export function leerDuracion(stderr: string): number | null {
  const duracion = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!duracion) return null
  return Number(duracion[1]) * 3600 + Number(duracion[2]) * 60 + Number(duracion[3])
}

export interface Pistas {
  video: boolean
  audio: boolean
  /** Del primer video, o 0 si no se pudo leer. */
  ancho: number
  alto: number
}

/** Las pistas que lista ffmpeg. La tapa de un disco figura como video («attached pic») y no cuenta. */
export function leerPistas(stderr: string): Pistas {
  const pistas: Pistas = { video: false, audio: false, ancho: 0, alto: 0 }
  for (const [, tipo, detalle] of stderr.matchAll(/^\s*Stream #[^\n]*?: (Video|Audio): ([^\n]*)$/gm)) {
    if (tipo === 'Audio') {
      pistas.audio = true
      continue
    }
    if (detalle.includes('attached pic') || pistas.video) continue
    pistas.video = true
    const lados = /(?:^|[ ,])(\d{2,5})x(\d{2,5})(?=[ ,\[]|$)/.exec(detalle)
    if (lados) {
      pistas.ancho = Number(lados[1])
      pistas.alto = Number(lados[2])
    }
  }
  return pistas
}

export interface Analisis extends Pistas {
  /** 0 si ffmpeg no sabe cuánto dura. */
  segundos: number
}

/** Qué pistas tiene y cuánto dura. Tira ErrorMultimedia si ffmpeg no encuentra ni audio ni imagen. */
export async function analizar(ruta: string): Promise<Analisis> {
  // Sin archivo de salida ffmpeg termina con código 1, como es de esperar: lo que sirve es lo que imprime.
  const { stderr } = await ejecutar(['-nostdin', '-hide_banner', ...(await entradaDe(ruta))], 60_000)
  const pistas = leerPistas(stderr)
  if (!pistas.video && !pistas.audio) throw new ErrorMultimedia(`ffmpeg no encontró audio ni imagen (${ultimaLinea(stderr)})`, 'ilegible')
  return { ...pistas, segundos: leerDuracion(stderr) ?? 0 }
}

async function carpetaTemporal(): Promise<string> {
  return mkdtemp(join(os.tmpdir(), 'cuestionario-multimedia-'))
}

// ---------------------------------------------------------------------------------------------
// Transcripción: funciones puras
// ---------------------------------------------------------------------------------------------

/** ¿Habla alguien? Con silencio o ruido de fondo Whisper inventa palabras («de la», «y»): mejor no transcribir. */
export function tieneVoz(pcm: Float32Array): boolean {
  const ventana = FRECUENCIA / 2
  for (let inicio = 0; inicio < pcm.length; inicio += ventana) {
    const fin = Math.min(pcm.length, inicio + ventana)
    let suma = 0
    for (let i = inicio; i < fin; i++) suma += pcm[i] * pcm[i]
    if (Math.sqrt(suma / (fin - inicio)) > 0.01) return true
  }
  return false
}

const LARGO_MAXIMO_DE_BUCLE = 8
const REPETICIONES_DE_BUCLE = 5

function palabraBase(palabra: string): string {
  return palabra.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Cuántas veces seguidas se repite la secuencia de `largo` palabras que empieza en `desde`. */
function repeticiones(palabras: string[], desde: number, largo: number): number {
  let veces = 1
  for (;;) {
    const siguiente = desde + veces * largo
    if (siguiente + largo > palabras.length) return veces
    for (let i = 0; i < largo; i++) if (palabras[desde + i] !== palabras[siguiente + i]) return veces
    veces++
  }
}

/** Una secuencia de 1 a 8 palabras repetida 5 veces o más seguidas: Whisper se quedó enganchado. */
export function hayBucle(texto: string): boolean {
  const palabras = texto.split(/\s+/).map(palabraBase).filter(Boolean)
  for (let desde = 0; desde < palabras.length; desde++) {
    for (let largo = 1; largo <= LARGO_MAXIMO_DE_BUCLE; largo++) {
      if (repeticiones(palabras, desde, largo) >= REPETICIONES_DE_BUCLE) return true
    }
  }
  return false
}

/** Deja dos repeticiones de cada bucle: se entiende que lo dijo varias veces sin llenar el material de basura. */
export function colapsarBucles(texto: string): string {
  const originales = texto.split(/\s+/).filter(Boolean)
  const palabras = originales.map(palabraBase)
  const salida: string[] = []
  let i = 0
  while (i < originales.length) {
    let saltado = false
    for (let largo = 1; largo <= LARGO_MAXIMO_DE_BUCLE && !saltado; largo++) {
      const veces = repeticiones(palabras, i, largo)
      if (veces >= REPETICIONES_DE_BUCLE) {
        salida.push(...originales.slice(i, i + 2 * largo))
        i += veces * largo
        saltado = true
      }
    }
    if (!saltado) salida.push(originales[i++])
  }
  return salida.join(' ')
}

// Con un tono, música o ruido de fondo, Whisper escribe el crédito de los subtítulos con los que
// aprendió. Nadie dice eso en un audio de WhatsApp: si aparece, no lo dijo nadie.
const CREDITOS_INVENTADOS = /subt[ií]tulos?(?:\s+\p{L}+){0,4}\s+(?:por|de)\s+(?:la\s+comunidad\s+de\s+)?amara\.org\.?/giu

/** Saca el crédito de subtítulos que Whisper inventa cuando no habla nadie. Lo demás queda igual. */
export function quitarCreditosInventados(texto: string): string {
  return texto.replace(CREDITOS_INVENTADOS, ' ').replace(/\s+/g, ' ').trim()
}

/** ¿Quedó alguna palabra? Whisper a veces devuelve solo puntos suspensivos. */
function dicePalabras(texto: string): boolean {
  return /[\p{L}\p{N}]/u.test(texto)
}

// ---------------------------------------------------------------------------------------------
// Transcripción: el proceso hijo
// ---------------------------------------------------------------------------------------------

const TOPE_CARGA_MS = 120_000
const OCIO_MS = 30_000
const HORA = 60 * 60_000

/** El hijo se cayó con un pedido en curso. */
class CaidaDelTranscriptor extends Error {
  constructor(
    readonly senal: NodeJS.Signals | null,
    detalle: string,
  ) {
    super(detalle)
  }
}

interface Pedido {
  id: string
  resolver: (texto: string) => void
  rechazar: (err: Error) => void
}

interface Trabajador {
  hijo: ChildProcess
  listo: Promise<void>
  pedido: Pedido | null
  ocio: NodeJS.Timeout | null
  terminado: boolean
  /** Lo último que escribió en stderr, para decir por qué se cayó. */
  registro: string
}

interface EstadoDeTranscripcion {
  /** Una transcripción por vez en todo el servidor: dos modelos cargados a la vez no entran en la memoria. */
  cola: Promise<unknown>
  enCurso: Map<string, Promise<Transcripcion>>
  /** Archivos que ya fallaron por culpa propia: no se vuelven a intentar en cada «Seguir». */
  fallas: Map<string, { error: ErrorMultimedia; cuando: number }>
  trabajador: Trabajador | null
  /** Cómo salió la prueba de arranque. null: todavía no corrió. */
  prueba: { ok: boolean; detalle: string } | null
  /** Lo último que se le contestó a /api/salud. Acá y no en el módulo: la prueba de arranque lo borra desde otra copia del módulo. */
  salud: { estado: EstadoMultimedia; cuando: number } | null
}

// En globalThis y no en el módulo: Next puede cargar este archivo una vez por ruta (la de subir y
// la de procesar), y con dos copias correrían dos Whisper a la vez.
const compartido = globalThis as unknown as { __transcripcion?: EstadoDeTranscripcion }

function estado(): EstadoDeTranscripcion {
  compartido.__transcripcion ??= { cola: Promise.resolve(), enCurso: new Map(), fallas: new Map(), trabajador: null, prueba: null, salud: null }
  return compartido.__transcripcion
}

function enCola<T>(tarea: () => Promise<T>): Promise<T> {
  const resultado = estado().cola.then(tarea)
  // La cola nunca queda rechazada: la falla de un audio no puede frenar al que sigue.
  estado().cola = resultado.catch(() => undefined)
  return resultado
}

function lanzarTrabajador(): Trabajador {
  const ruta = rutaTranscriptor()
  const hijo = spawn(process.execPath, [ruta], {
    cwd: dirname(ruta),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DIR_MODELOS: dirModelos(), MODELO_TRANSCRIPCION: modeloDeTranscripcion() },
  })
  let avisarListo: () => void = () => {}
  let avisarFalla: (err: Error) => void = () => {}
  const trabajador: Trabajador = {
    hijo,
    listo: new Promise<void>((resolver, rechazar) => {
      avisarListo = resolver
      avisarFalla = rechazar
    }),
    pedido: null,
    ocio: null,
    terminado: false,
    registro: '',
  }
  // Si nadie espera la carga (se pidió y se venció), que falle no puede tirar abajo el servidor.
  trabajador.listo.catch(() => undefined)

  const cargando = setTimeout(() => {
    avisarFalla(new ErrorMultimedia(`El transcriptor no terminó de cargar el modelo en ${TOPE_CARGA_MS / 1000} segundos.`, 'sin_herramienta'))
    hijo.kill('SIGKILL')
  }, TOPE_CARGA_MS)

  hijo.on('error', (err) => {
    clearTimeout(cargando)
    trabajador.terminado = true
    const falla = new ErrorMultimedia(`No se pudo lanzar el transcriptor (${err.message}): revisá RUTA_TRANSCRIPTOR.`, 'sin_herramienta')
    avisarFalla(falla)
    trabajador.pedido?.rechazar(falla)
    trabajador.pedido = null
  })

  hijo.stderr?.setEncoding('utf8')
  hijo.stderr?.on('data', (texto: string) => {
    trabajador.registro = (trabajador.registro + texto).slice(-2000)
  })
  // Escribirle a un hijo que ya se cayó da error en el canal: la caída se atiende en 'exit'.
  hijo.stdin?.on('error', () => undefined)

  // stdout es solo del protocolo, pero una biblioteca puede imprimir algo por su cuenta: lo que no
  // es un mensaje se ignora en vez de romper la lectura.
  const lineas = createInterface({ input: hijo.stdout! })
  lineas.on('line', (linea) => {
    let mensaje: { listo?: boolean; error?: string; id?: string; texto?: string }
    try {
      mensaje = JSON.parse(linea)
    } catch {
      return
    }
    if (typeof mensaje !== 'object' || mensaje === null) return
    if (typeof mensaje.listo === 'boolean') {
      clearTimeout(cargando)
      if (mensaje.listo) avisarListo()
      else avisarFalla(new ErrorMultimedia(`El transcriptor no pudo arrancar: ${mensaje.error ?? 'sin detalle'}`, 'sin_herramienta'))
      return
    }
    const pedido = trabajador.pedido
    if (!pedido || mensaje.id !== pedido.id) return
    trabajador.pedido = null
    if (typeof mensaje.texto === 'string') pedido.resolver(mensaje.texto)
    else pedido.rechazar(new ErrorMultimedia(`el transcriptor no pudo con el audio (${mensaje.error ?? 'sin detalle'})`, 'ilegible'))
  })

  hijo.on('exit', (codigo, senal) => {
    clearTimeout(cargando)
    if (trabajador.ocio) clearTimeout(trabajador.ocio)
    trabajador.terminado = true
    if (estado().trabajador === trabajador) estado().trabajador = null
    const detalle = `el transcriptor terminó con ${senal ? `la señal ${senal}` : `código ${codigo}`}: ${ultimaLinea(trabajador.registro)}`
    avisarFalla(new ErrorMultimedia(detalle, 'sin_herramienta'))
    trabajador.pedido?.rechazar(new CaidaDelTranscriptor(senal, detalle))
    trabajador.pedido = null
  })

  // Que transcribir no le saque el procesador a quien está subiendo archivos.
  try {
    if (hijo.pid) os.setPriority(hijo.pid, 10)
  } catch {
    // Sin permiso para cambiar la prioridad: corre con la normal.
  }
  // El hijo no tiene que mantener vivo el proceso cuando ya no hay nada que hacer (pruebas, cierre de Next).
  hijo.unref()
  for (const canal of [hijo.stdin, hijo.stdout, hijo.stderr]) (canal as unknown as { unref?: () => void } | null)?.unref?.()
  return trabajador
}

async function trabajadorListo(): Promise<Trabajador> {
  let trabajador = estado().trabajador
  if (!trabajador || trabajador.terminado) {
    trabajador = lanzarTrabajador()
    estado().trabajador = trabajador
  }
  if (trabajador.ocio) {
    clearTimeout(trabajador.ocio)
    trabajador.ocio = null
  }
  await trabajador.listo
  return trabajador
}

function dejarEnOcio(trabajador: Trabajador): void {
  if (trabajador.terminado) return
  // Sin trabajo por un rato, se cierra: el modelo cargado ocupa cerca de 1 GB que el servidor necesita.
  trabajador.ocio = setTimeout(() => trabajador.hijo.stdin?.end(), OCIO_MS)
  trabajador.ocio.unref()
}

async function pedirAlTranscriptor(pcm: string, segundos: number, intento = 1): Promise<string> {
  const trabajador = await trabajadorListo()
  const topeMs = Math.max(120_000, Math.ceil(segundos * 3000))
  try {
    return await new Promise<string>((resolver, rechazar) => {
      const id = randomUUID()
      const reloj = setTimeout(() => {
        trabajador.pedido = null
        trabajador.hijo.kill('SIGKILL')
        rechazar(new ErrorMultimedia(`el transcriptor tardó más de ${Math.round(topeMs / 1000)} segundos`, 'tiempo'))
      }, topeMs)
      trabajador.pedido = {
        id,
        resolver: (texto) => {
          clearTimeout(reloj)
          resolver(texto)
        },
        rechazar: (err) => {
          clearTimeout(reloj)
          rechazar(err)
        },
      }
      trabajador.hijo.stdin!.write(`${JSON.stringify({ id, pcm, segundos })}\n`, (err) => {
        if (err) trabajador.pedido?.rechazar(new CaidaDelTranscriptor(null, `no se le pudo escribir al transcriptor: ${err.message}`))
      })
    })
  } catch (err) {
    if (!(err instanceof CaidaDelTranscriptor)) throw err
    // Una caída puede ser mala suerte (el servidor sin memoria en ese momento): se prueba una vez
    // más con un proceso nuevo. Si se cae de nuevo por una señal, el problema es del servidor y
    // no del archivo; si se cae solo, es el archivo el que lo tira.
    if (intento === 1) return pedirAlTranscriptor(pcm, segundos, 2)
    throw new ErrorMultimedia(err.message, err.senal ? 'sin_herramienta' : 'ilegible')
  } finally {
    dejarEnOcio(trabajador)
  }
}

/** Cierra el transcriptor sin esperar al ocio. Para las pruebas y para apagar el servidor. */
export async function cerrarTranscriptor(): Promise<void> {
  const trabajador = estado().trabajador
  if (!trabajador || trabajador.terminado) return
  await new Promise<void>((resolver) => {
    const forzar = setTimeout(() => trabajador.hijo.kill('SIGKILL'), 2000)
    trabajador.hijo.once('exit', () => {
      clearTimeout(forzar)
      resolver()
    })
    trabajador.hijo.stdin?.end()
  })
}

// ---------------------------------------------------------------------------------------------
// Transcripción: caché y cola
// ---------------------------------------------------------------------------------------------

export interface OpcionesDeTranscripcion {
  /** sha256 del archivo, si ya se sabe. Es la clave de la caché. */
  hash?: string
  /** Carpeta del cuestionario donde se guardan las transcripciones. */
  dirCache: string
}

function rutaDeCache(dirCache: string, hash: string): string {
  return join(dirCache, `${hash}.${modeloDeTranscripcion()}.json`)
}

async function leerCache(ruta: string): Promise<Transcripcion | null> {
  try {
    return JSON.parse(await readFile(ruta, 'utf8')) as Transcripcion
  } catch {
    return null
  }
}

async function escribirCache(ruta: string, contenido: unknown): Promise<void> {
  // La carpeta no existe en un volumen que ya tenía datos: se crea antes de escribir.
  await mkdir(dirname(ruta), { recursive: true })
  const temporal = `${ruta}.${randomUUID()}.tmp`
  await writeFile(temporal, JSON.stringify(contenido))
  await rename(temporal, ruta)
}

/**
 * ¿Hay algo que esperar de este audio? false si su transcripción ya está guardada o si nadie la
 * está haciendo (terminó, falló o el servidor se reinició): en los tres casos conviene volver a
 * tocar «Seguir», que la usa, la anota como no leída o la empieza de nuevo.
 */
export function transcripcionPendiente(dirCache: string, hash: string): boolean {
  if (existsSync(rutaDeCache(dirCache, hash))) return false
  return estado().enCurso.has(`${hash}.${modeloDeTranscripcion()}`)
}

/**
 * El audio de un audio o de un video, pasado a texto. La misma transcripción no se hace dos
 * veces: se guarda por hash en `dirCache`, y dos pedidos a la vez del mismo archivo esperan al
 * mismo trabajo.
 */
export async function transcribirAudio(ruta: string, opciones: OpcionesDeTranscripcion): Promise<Transcripcion> {
  const hash = opciones.hash ?? (await hashDeArchivo(ruta))
  const clave = `${hash}.${modeloDeTranscripcion()}`
  const cache = rutaDeCache(opciones.dirCache, hash)
  const guardada = await leerCache(cache)
  if (guardada) return guardada

  const { enCurso, fallas } = estado()
  const falla = fallas.get(clave)
  if (falla && Date.now() - falla.cuando < HORA) throw falla.error
  const yaEmpezada = enCurso.get(clave)
  if (yaEmpezada) return yaEmpezada

  const trabajo = enCola(() => transcribirSinCache(ruta))
    .then(async (transcripcion) => {
      await escribirCache(cache, transcripcion).catch((err) => console.error('[multimedia] no se pudo guardar la transcripción:', err))
      return transcripcion
    })
    .catch((err: unknown) => {
      // Si la culpa es del servidor (falta una herramienta) no se anota: cuando se arregle, anda.
      if (err instanceof ErrorMultimedia && err.causa !== 'sin_herramienta') fallas.set(clave, { error: err, cuando: Date.now() })
      throw err
    })
    .finally(() => enCurso.delete(clave))
  enCurso.set(clave, trabajo)
  return trabajo
}

function sinVoz(segundos: number): Transcripcion {
  return { texto: '', segundos, sinVoz: true, dudosa: false, recortada: false }
}

async function transcribirSinCache(ruta: string): Promise<Transcripcion> {
  const analisis = await analizar(ruta)
  if (!analisis.audio) return sinVoz(redondear(analisis.segundos))

  const carpeta = await carpetaTemporal()
  const pcm = join(carpeta, 'audio.pcm')
  try {
    const salida = await ejecutar(
      [...SILENCIOSO, ...(await entradaDe(ruta)), '-vn', '-ac', '1', '-ar', String(FRECUENCIA), '-t', String(SEGUNDOS_MAXIMOS_DE_AUDIO), '-f', 'f32le', pcm],
      TOPE_FFMPEG_MS,
    )
    if (salida.codigo !== 0) throw new ErrorMultimedia(`ffmpeg no pudo sacar el audio (${ultimaLinea(salida.stderr)})`, 'ilegible')

    const datos = await readFile(pcm)
    const bytes = datos.length - (datos.length % 4)
    // Un Buffer puede ser una vista sin alinear a 4 bytes, y Float32Array la rechazaría: ahí se
    // copia. Si ya está alineado se usa tal cual, que quince minutos de audio son casi 60 MB.
    const muestras =
      datos.byteOffset % 4 === 0
        ? new Float32Array(datos.buffer, datos.byteOffset, bytes / 4)
        : new Float32Array(new Uint8Array(datos.subarray(0, bytes)).buffer)
    const escuchados = muestras.length / FRECUENCIA
    const segundos = redondear(analisis.segundos || escuchados)
    if (!muestras.length || !tieneVoz(muestras)) return sinVoz(segundos)

    const crudo = (await pedirAlTranscriptor(pcm, escuchados)).replace(/[⟪⟫]/g, '').replace(/\s+/g, ' ').trim()
    const sinCreditos = quitarCreditosInventados(crudo)
    // Había sonido pero ninguna palabra: es un ruido, un tono o música, no alguien hablando.
    if (!dicePalabras(sinCreditos)) return sinVoz(segundos)
    const texto = colapsarBucles(sinCreditos)
    const palabras = texto.split(' ').filter(Boolean).length
    return {
      texto,
      segundos,
      sinVoz: false,
      // Un bucle, un crédito inventado o casi nada de texto para lo que dura: no es de fiar.
      dudosa: hayBucle(crudo) || sinCreditos !== crudo || (palabras <= 2 && escuchados > 5),
      recortada: analisis.segundos > SEGUNDOS_MAXIMOS_DE_AUDIO + 1,
    }
  } finally {
    await rm(carpeta, { recursive: true, force: true })
  }
}

function redondear(segundos: number): number {
  return Math.round(segundos * 10) / 10
}

/**
 * Empieza a transcribir apenas termina de subir, sin esperar a «Listo, seguir»: cuando la persona
 * sigue, lo más probable es que ya esté hecho. No toca el estado ni el candado del cuestionario;
 * solo deja el resultado en la caché. `ADELANTAR_TRANSCRIPCION=0` lo apaga (las pruebas).
 */
export function adelantarTranscripcion(ruta: string, opciones: OpcionesDeTranscripcion): void {
  if (process.env.ADELANTAR_TRANSCRIPCION === '0') return
  transcribirAudio(ruta, opciones).catch((err) => {
    // Al seguir se intenta de nuevo y ahí queda la nota en el archivo: acá alcanza con dejarlo en el registro.
    console.warn(`[multimedia] no se pudo adelantar una transcripción: ${err instanceof Error ? err.message : String(err)}`)
  })
}

/** Transcribe un segundo de silencio: si esto anda, el modelo carga y el transcriptor responde. */
export async function probarTranscriptor(): Promise<{ ok: boolean; detalle: string }> {
  const carpeta = await carpetaTemporal()
  try {
    const pcm = join(carpeta, 'silencio.pcm')
    await writeFile(pcm, Buffer.alloc(FRECUENCIA * 4))
    await enCola(() => pedirAlTranscriptor(pcm, 1))
    estado().prueba = { ok: true, detalle: 'ok' }
  } catch (err) {
    estado().prueba = { ok: false, detalle: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(carpeta, { recursive: true, force: true })
  }
  return estado().prueba!
}

// ---------------------------------------------------------------------------------------------
// Video e imágenes
// ---------------------------------------------------------------------------------------------

/** Parejos a lo largo del video. La detección de cambio de escena no saca nada en una toma de celular. */
export function cuantosFotogramas(segundos: number): number {
  if (segundos <= 20) return 4
  return segundos <= 60 ? 6 : 8
}

function escala(lado: number): string {
  return `scale='min(${lado},iw)':'min(${lado},ih)':force_original_aspect_ratio=decrease`
}

async function leerCuadros(carpeta: string): Promise<Buffer[]> {
  const nombres = (await readdir(carpeta)).filter((nombre) => nombre.endsWith('.jpg'))
  nombres.sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0))
  const cuadros: Buffer[] = []
  for (const nombre of nombres) {
    const cuadro = await readFile(join(carpeta, nombre))
    if (cuadro.length) cuadros.push(cuadro)
  }
  return cuadros
}

/** Fotogramas en JPEG de hasta 1024 px para que Claude describa lo que se ve. */
export async function fotogramasDeVideo(ruta: string): Promise<Fotogramas> {
  const analisis = await analizar(ruta)
  const base = { segundos: redondear(analisis.segundos), tieneAudio: analisis.audio }
  if (!analisis.video) return { ...base, cuadros: [], tieneVideo: false }

  const cantidad = cuantosFotogramas(analisis.segundos)
  const entrada = await entradaDe(ruta)
  const carpeta = await carpetaTemporal()
  const limite = Date.now() + TOPE_FFMPEG_MS
  const queda = () => Math.max(1000, limite - Date.now())
  try {
    // Una pasada con el filtro fps decodifica el video entero: en uno largo o en 4K no termina a
    // tiempo. Ahí se salta a cada momento con -ss antes de -i, que busca sin decodificar.
    const pesado = analisis.segundos > 60 || Math.max(analisis.ancho, analisis.alto) > 1920
    if (pesado && analisis.segundos > 0) {
      for (let i = 0; i < cantidad && Date.now() < limite; i++) {
        const momento = ((i + 0.5) * analisis.segundos) / cantidad
        await ejecutar(
          [...SILENCIOSO, '-ss', momento.toFixed(2), ...entrada, '-an', '-frames:v', '1', '-vf', escala(1024), '-q:v', '4', join(carpeta, `f${i + 1}.jpg`)],
          queda(),
        ).catch((err) => {
          // Un momento que no se pudo sacar no invalida los demás; sin ffmpeg no hay nada que hacer.
          if (err instanceof ErrorMultimedia && err.causa === 'sin_herramienta') throw err
        })
      }
    } else {
      const ritmo = `fps=${cantidad}/${Math.max(analisis.segundos, 1).toFixed(3)}`
      await ejecutar(
        [...SILENCIOSO, ...entrada, '-an', '-vf', `${ritmo},${escala(1024)}`, '-frames:v', String(cantidad), '-q:v', '4', join(carpeta, 'f%d.jpg')],
        queda(),
      )
    }
    let cuadros = await leerCuadros(carpeta)
    if (!cuadros.length) {
      // Videos de menos de un cuadro por intervalo, o con la duración mal escrita: alcanza con el primero.
      const salida = await ejecutar([...SILENCIOSO, ...entrada, '-an', '-vf', escala(1024), '-frames:v', '1', '-q:v', '4', join(carpeta, 'f1.jpg')], queda())
      cuadros = await leerCuadros(carpeta)
      if (!cuadros.length) throw new ErrorMultimedia(`ffmpeg no pudo sacar ningún fotograma (${ultimaLinea(salida.stderr)})`, 'ilegible')
    }
    return { ...base, cuadros, tieneVideo: true }
  } finally {
    await rm(carpeta, { recursive: true, force: true })
  }
}

// Lo que Claude acepta por imagen: 10 MB medidos en base64 (unos 7,5 MB del archivo) y 8000 px por lado.
const LIMITE_BYTES_IMAGEN = Math.floor((10 * 1024 * 1024) / 4) * 3
const LIMITE_LADO_IMAGEN = 8000
// Claude achica por dentro todo lo que pasa de este lado: mandarle más no mejora la lectura.
const LADO_AL_CONVERTIR = 1568
const MIMES_DE_CLAUDE = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * La imagen como la acepta Claude. La original si ya sirve; si no (HEIC del iPhone, BMP, TIFF,
 * AVIF, o demasiado pesada o grande), convertida a JPEG. Así no hay que pedirle a nadie que
 * convierta sus fotos antes de subirlas.
 */
export async function imagenParaClaude(ruta: string, mime: string): Promise<ImagenParaClaude> {
  const { size: tamano } = await stat(ruta)
  if (MIMES_DE_CLAUDE.has(mime) && tamano <= LIMITE_BYTES_IMAGEN) {
    const datos = await readFile(ruta)
    const lados = ladosDeImagen(datos, mime)
    // Sin poder leer el tamaño decide Claude, como siempre.
    if (!lados || Math.max(...lados) <= LIMITE_LADO_IMAGEN) return { datos, mime: mime as MimeImagenClaude }
  }

  const entrada = await entradaDe(ruta)
  const carpeta = await carpetaTemporal()
  const salida = join(carpeta, 'imagen.jpg')
  const final = ['-frames:v', '1', '-update', '1', '-q:v', '3', salida]
  // La foto del iPhone viene en mosaicos que ffmpeg arma como un grupo: se pide el grupo, y si el
  // archivo no lo trae (un HEIC de una sola pieza), la pista común.
  const intentos: string[][] = [['-vf', escala(LADO_AL_CONVERTIR)]]
  if (mime === 'image/heic' || mime === 'image/avif') intentos.unshift(['-filter_complex', `[0:g:0]${escala(LADO_AL_CONVERTIR)}[v]`, '-map', '[v]'])
  try {
    let detalle = 'sin detalle'
    for (const filtro of intentos) {
      const resultado = await ejecutar([...SILENCIOSO, ...entrada, ...filtro, ...final], TOPE_FFMPEG_MS)
      const datos = resultado.codigo === 0 ? await readFile(salida).catch(() => null) : null
      if (datos?.length) return { datos, mime: 'image/jpeg' }
      detalle = ultimaLinea(resultado.stderr)
    }
    throw new ErrorMultimedia(`ffmpeg no pudo convertir la imagen (${detalle})`, 'ilegible')
  } finally {
    await rm(carpeta, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Salud
// ---------------------------------------------------------------------------------------------

export interface EstadoMultimedia {
  ok: boolean
  /** Cada campo dice 'ok' o qué falta. */
  ffmpeg: string
  transcriptor: string
  modelo: string
}

/** Qué falta para leer audios y videos. Con caché de un minuto: /api/salud se consulta seguido. */
export async function estadoMultimedia(): Promise<EstadoMultimedia> {
  const guardada = estado().salud
  if (guardada && Date.now() - guardada.cuando < 60_000) return guardada.estado

  let ffmpeg = 'ok'
  try {
    const version = await ejecutar(['-version'], 10_000)
    if (version.codigo !== 0) ffmpeg = 'ffmpeg no arranca: revisá RUTA_FFMPEG.'
  } catch (err) {
    ffmpeg = err instanceof Error ? err.message : String(err)
  }

  const ruta = rutaTranscriptor()
  let transcriptor = 'ok'
  if (!existsSync(ruta)) transcriptor = 'Falta transcriptor/transcribir.mjs: revisá RUTA_TRANSCRIPTOR.'
  else if (!existsSync(join(dirname(ruta), 'node_modules', '@huggingface', 'transformers', 'package.json'))) {
    transcriptor = 'Faltan las dependencias del transcriptor: corré npm install.'
  } else if (estado().prueba && !estado().prueba!.ok) {
    transcriptor = `No pasó la prueba de arranque: ${estado().prueba!.detalle}`
  }

  const nombre = modeloDeTranscripcion()
  // turbopackIgnore: sin esto el build encuentra el modelo bajado en local (240 MB) y lo copia al standalone.
  const carpeta = join(/*turbopackIgnore: true*/ dirModelos(), 'onnx-community', nombre)
  const faltantes = ARCHIVOS_DEL_MODELO[nombre].filter((archivo) => !existsSync(join(/*turbopackIgnore: true*/ carpeta, archivo)))
  const modelo = faltantes.length ? `Falta el modelo ${nombre} en DIR_MODELOS: corré npm run modelo.` : 'ok'

  const actual: EstadoMultimedia = { ok: ffmpeg === 'ok' && transcriptor === 'ok' && modelo === 'ok', ffmpeg, transcriptor, modelo }
  estado().salud = { estado: actual, cuando: Date.now() }
  return actual
}

/** Para que la prueba de arranque se vea en /api/salud sin esperar a que venza la caché. */
export function olvidarEstadoMultimedia(): void {
  estado().salud = null
}
