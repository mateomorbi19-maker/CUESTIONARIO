import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib'
import { esArchivoDeSistema } from './grupos'
import { LIMITE_BYTES_ARCHIVO } from './limites'

export { LIMITE_BYTES_ARCHIVO }

/** Igual que en `lib/motor/tipos.ts`. Se repite para que leer archivos no dependa del motor: si cambia uno, cambiá el otro. */
export type TipoMaterial = 'imagen' | 'pdf' | 'texto' | 'audio' | 'video' | 'otro'

/** Lo único que frena una subida: un archivo vacío, uno que pasa el límite o un .zip que no se puede abrir. */
export class ErrorArchivo extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErrorArchivo'
  }
}

export interface ArchivoLeido {
  tipo: TipoMaterial
  /** El del archivo original, sacado de sus bytes: el navegador manda cualquier cosa. */
  mime: string
  /**
   * null para imagen, pdf, audio y video: se leen al tocar «Listo, seguir». '' en lo que no se
   * puede leer, que va con su problema.
   */
  texto: string | null
  /** Por qué no se puede leer, dicho para el dueño. El archivo se guarda igual: no se frena por un archivo. */
  problema: string | null
}

// Un chat de meses entra de sobra; más que esto encarece cada llamada a Claude sin sumar.
const LIMITE_CARACTERES = 300_000
// Un Word o un Excel reales no llegan ni cerca; pasarlo es señal de un zip armado para tumbar el servidor.
const LIMITE_BYTES_DESCOMPRIMIDOS = 200 * 1024 * 1024
// Alcanza para ver si es binario sin recorrer el archivo entero.
const BYTES_PARA_DETECTAR_TEXTO = 8 * 1024
// Con esto se reconoce cualquier formato por su firma sin cargar un video entero en memoria.
const BYTES_DE_CABECERA = 512 * 1024
// Texto, Word y Excel se leen enteros en memoria: más que esto no es un documento de un negocio.
const LIMITE_BYTES_PARA_TEXTO = 20 * 1024 * 1024

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const MENSAJE_VACIO = 'El archivo está vacío. Volvé a guardarlo o exportarlo y subilo de nuevo.'
const MENSAJE_PESADO =
  'El archivo pesa más de 200 MB. Si es un video, mandá uno más corto; si es un .zip, exportá cada conversación por separado.'
const MENSAJE_OFFICE_VIEJO =
  'Los Word y Excel viejos (.doc, .xls) no los podemos leer. Si tiene algo importante, guardalo como .docx o .xlsx y subilo de nuevo.'
/** El mismo texto que PROBLEMA_FORMATO de lib/motor/textos.ts: este módulo no depende del motor. */
export const PROBLEMA_FORMATO =
  'Este tipo de archivo no lo podemos leer. Queda guardado igual: si tiene algo importante, mandalo como PDF, captura o texto.'
const MENSAJE_ZIP_ANIDADO = 'Un .zip adentro de otro no se abre: subilo aparte.'
const MENSAJE_GRANDE_PARA_TEXTO =
  'Es demasiado grande para leerlo como texto. Si tiene algo importante, subí solo la parte que importa.'
const MENSAJE_ZIP_DANADO = 'El archivo .zip está dañado. Volvé a exportarlo y subilo de nuevo.'
const MENSAJE_ZIP_ENORME =
  'El archivo descomprimido pesa más de 200 MB. Subí solo lo que importa: si es un chat de WhatsApp, exportalo sin archivos multimedia.'
const MENSAJE_ZIP_MUCHOS = 'El .zip trae demasiados archivos. Subí las conversaciones de a una.'

// Word y Excel también son .zip por dentro: sin esto, el dueño que sube un .docx roto lee que su «.zip» está dañado.
const MENSAJE_DANADO_POR_EXTENSION: Record<string, string> = {
  docx: 'El archivo de Word está dañado. Abrilo, guardalo de nuevo y volvé a subirlo.',
  xlsx: 'El archivo de Excel está dañado. Abrilo, guardalo de nuevo y volvé a subirlo.',
}

const MENSAJE_SIN_TEXTO: Record<'docx' | 'xlsx', string> = {
  docx: 'El Word no tiene texto para leer: puede que tenga solo fotos pegadas. Guardalo como PDF y subí ese.',
  xlsx: 'El Excel no tiene celdas con datos. Revisá que sea el archivo correcto y volvé a subirlo.',
}

function mensajeExtensionFalsa(extension: string): string {
  return `El archivo dice ser .${extension} pero por dentro no lo es o está dañado. Abrilo en tu compu o celular, guardalo de nuevo y volvé a subirlo.`
}

const EXTENSIONES_TEXTO = new Set(['txt', 'csv', 'tsv', 'md', 'json'])
// Solo por el nombre no alcanza: lo que no trae la firma de un audio, un video o una foto no se
// le pasa a ffmpeg, que abre lo que el contenido le diga (una lista HLS renombrada a .mp4 lo haría
// pedir direcciones de la red interna). Queda guardado como archivo que no se puede leer.
const EXTENSIONES_MULTIMEDIA = new Set([
  'opus', 'ogg', 'oga', 'm4a', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'aac', 'flac', 'amr', '3gp', 'avi', 'mkv', 'mpeg', 'mpg', 'wma', 'wmv',
  'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff',
])
const EXTENSIONES_OFFICE_VIEJO = new Set(['doc', 'xls', 'ppt'])
// Las que se aceptan por firma: si llegan hasta el final sin coincidir, el archivo miente o está roto.
const EXTENSIONES_BINARIAS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'zip'])

const MARCAS_HEIC = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])
const MARCAS_AVIF = new Set(['avif', 'avis'])
const MARCAS_AUDIO_MP4 = new Set(['M4A ', 'M4B ', 'M4P '])
// Los QuickTime viejos no traen «ftyp»: arrancan directo con uno de estos átomos.
const ATOMOS_QUICKTIME = new Set(['moov', 'mdat', 'wide', 'free'])
// Sincronía de cuadro de MP3 y AAC. FF FE queda afuera a propósito: es el BOM de un texto UTF-16.
const SEGUNDO_BYTE_MP3 = new Set([0xfb, 0xfa, 0xf3, 0xf2])
const SEGUNDO_BYTE_AAC = new Set([0xf1, 0xf9])
const CABECERAS_BMP = new Set([12, 40, 52, 56, 64, 108, 124])

/** Qué es un archivo según sus bytes, y con qué lector lo abre ffmpeg. */
export interface Firma {
  tipo: 'imagen' | 'pdf' | 'audio' | 'video'
  mime: string
  /** El demuxer de ffmpeg para `-f`. null: no pasa por ffmpeg (un PDF). */
  formato: string | null
}

function extensionDe(nombre: string): string {
  return /\.([^./\\]+)$/.exec(nombre)?.[1].toLowerCase() ?? ''
}

/**
 * La firma de un archivo, mirando solo sus primeros bytes. null si no es imagen, PDF, audio ni
 * video. El nombre solo se usa para los PDF con basura adelante, que la norma permite.
 */
export function firmaDe(datos: Buffer, nombre = ''): Firma | null {
  const inicio = datos.toString('latin1', 0, 12)

  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return { tipo: 'imagen', mime: 'image/jpeg', formato: 'jpeg_pipe' }
  if (inicio.startsWith('\x89PNG')) return { tipo: 'imagen', mime: 'image/png', formato: 'png_pipe' }
  if (inicio.startsWith('GIF8')) return { tipo: 'imagen', mime: 'image/gif', formato: 'gif' }
  if (inicio.startsWith('RIFF') && inicio.slice(8, 12) === 'WEBP') return { tipo: 'imagen', mime: 'image/webp', formato: 'webp_pipe' }
  // La norma de PDF permite basura antes del encabezado; solo se busca más adentro si dice ser PDF.
  if (inicio.startsWith('%PDF') || (extensionDe(nombre) === 'pdf' && datos.subarray(0, 1024).includes('%PDF'))) {
    return { tipo: 'pdf', mime: 'application/pdf', formato: null }
  }

  if (inicio.slice(4, 8) === 'ftyp') {
    const marca = inicio.slice(8, 12)
    if (MARCAS_HEIC.has(marca)) return { tipo: 'imagen', mime: 'image/heic', formato: 'mov' }
    if (MARCAS_AVIF.has(marca)) return { tipo: 'imagen', mime: 'image/avif', formato: 'mov' }
    if (MARCAS_AUDIO_MP4.has(marca)) return { tipo: 'audio', mime: 'audio/mp4', formato: 'mov' }
    if (marca === 'qt  ') return { tipo: 'video', mime: 'video/quicktime', formato: 'mov' }
    if (marca.startsWith('3g')) return { tipo: 'video', mime: 'video/3gpp', formato: 'mov' }
    // isom, mp42, avc1 y el resto. Un audio de WhatsApp puede venir con estas marcas: si al
    // abrirlo no tiene pista de imagen, el motor lo trata como audio.
    return { tipo: 'video', mime: 'video/mp4', formato: 'mov' }
  }
  // Los cuatro primeros bytes son el tamaño del átomo: un texto que diga «The free…» arranca con
  // letras, nunca con un byte de control.
  if (ATOMOS_QUICKTIME.has(inicio.slice(4, 8)) && datos[0] < 9) {
    return { tipo: 'video', mime: 'video/quicktime', formato: 'mov' }
  }

  if (inicio.startsWith('BM') && datos.length >= 18 && CABECERAS_BMP.has(datos.readUInt32LE(14))) {
    return { tipo: 'imagen', mime: 'image/bmp', formato: 'bmp_pipe' }
  }
  if (inicio.startsWith('II*\x00') || inicio.startsWith('MM\x00*')) return { tipo: 'imagen', mime: 'image/tiff', formato: 'tiff_pipe' }

  if (inicio.startsWith('OggS') && datos[4] === 0) return { tipo: 'audio', mime: 'audio/ogg', formato: 'ogg' }
  // Con el byte de versión: un .csv puede arrancar con «ID3» si es el código de un producto.
  if (inicio.startsWith('ID3') && datos[3] <= 4 && datos[4] === 0) return { tipo: 'audio', mime: 'audio/mpeg', formato: 'mp3' }
  if (inicio.startsWith('fLaC')) return { tipo: 'audio', mime: 'audio/flac', formato: 'flac' }
  if (inicio.startsWith('#!AMR')) return { tipo: 'audio', mime: 'audio/amr', formato: 'amr' }
  if (inicio.startsWith('RIFF') && inicio.slice(8, 12) === 'WAVE') return { tipo: 'audio', mime: 'audio/wav', formato: 'wav' }
  if (inicio.startsWith('RIFF') && inicio.slice(8, 12) === 'AVI ') return { tipo: 'video', mime: 'video/x-msvideo', formato: 'avi' }
  if (datos[0] === 0x1a && datos[1] === 0x45 && datos[2] === 0xdf && datos[3] === 0xa3) {
    return { tipo: 'video', mime: 'video/webm', formato: 'matroska' }
  }
  if (datos[0] === 0xff && SEGUNDO_BYTE_AAC.has(datos[1])) return { tipo: 'audio', mime: 'audio/aac', formato: 'aac' }
  if (datos[0] === 0xff && SEGUNDO_BYTE_MP3.has(datos[1])) return { tipo: 'audio', mime: 'audio/mpeg', formato: 'mp3' }
  return null
}

/** El lector con el que ffmpeg tiene que abrir el archivo, por su firma. null: no se le pasa a ffmpeg. */
export function formatoFfmpeg(cabecera: Buffer): string | null {
  return firmaDe(cabecera)?.formato ?? null
}

function otro(problema: string, mime = 'application/octet-stream'): ArchivoLeido {
  return { tipo: 'otro', mime, texto: '', problema }
}

/**
 * Qué es un archivo y, si es texto, Word o Excel, lo que dice.
 *
 * Solo tira si está vacío o pasa el límite. Todo lo demás se acepta: lo que no se puede leer
 * vuelve como 'otro' con su problema, para mostrarlo junto al archivo sin frenar la subida.
 */
export function leerArchivo(nombre: string, datos: Buffer): ArchivoLeido {
  if (datos.length === 0) throw new ErrorArchivo(MENSAJE_VACIO)
  if (datos.length > LIMITE_BYTES_ARCHIVO) throw new ErrorArchivo(MENSAJE_PESADO)

  const firma = firmaDe(datos, nombre)
  if (firma) return { tipo: firma.tipo, mime: firma.mime, texto: null, problema: null }

  const extension = extensionDe(nombre)
  const inicio = datos.toString('latin1', 0, 12)
  if (inicio.startsWith('PK\x03\x04')) return leerContenedorZip(extension, datos)
  // Formato compuesto de Office: lo usan los .doc y .xls viejos y los .docx con contraseña.
  if (inicio.startsWith('\xd0\xcf\x11\xe0') || EXTENSIONES_OFFICE_VIEJO.has(extension)) return otro(MENSAJE_OFFICE_VIEJO)

  const pareceTexto = tieneBomUtf16(datos) || !datos.subarray(0, BYTES_PARA_DETECTAR_TEXTO).includes(0)
  if (EXTENSIONES_TEXTO.has(extension)) {
    if (!pareceTexto) return otro(mensajeExtensionFalsa(extension))
    return texto(extension === 'csv' ? 'text/csv' : 'text/plain', decodificarTexto(datos), MENSAJE_VACIO)
  }
  if (EXTENSIONES_BINARIAS.has(extension)) return otro(mensajeExtensionFalsa(extension))
  if (EXTENSIONES_MULTIMEDIA.has(extension)) return otro(PROBLEMA_FORMATO)
  if (pareceTexto) return texto('text/plain', decodificarTexto(datos), MENSAJE_VACIO)

  return otro(PROBLEMA_FORMATO)
}

/**
 * Igual que `leerArchivo`, pero sin cargar en memoria lo que no hace falta: de un video de 150 MB
 * alcanza con la cabecera. Solo el texto, el Word y el Excel se leen enteros.
 */
export async function leerArchivoDeDisco(nombre: string, ruta: string): Promise<ArchivoLeido> {
  const { size: tamano } = await stat(ruta)
  if (tamano === 0) throw new ErrorArchivo(MENSAJE_VACIO)
  if (tamano > LIMITE_BYTES_ARCHIVO) throw new ErrorArchivo(MENSAJE_PESADO)

  const archivo = await open(ruta, 'r')
  try {
    const cabecera = await leerTramo(archivo, 0, Math.min(tamano, BYTES_DE_CABECERA))
    if (cabecera.length === tamano) return leerArchivo(nombre, cabecera)

    const firma = firmaDe(cabecera, nombre)
    if (firma) return { tipo: firma.tipo, mime: firma.mime, texto: null, problema: null }

    if (cabecera.toString('latin1', 0, 4) === 'PK\x03\x04') {
      let clase: ClaseDeZip
      try {
        clase = await claseDeZip(archivo, tamano)
      } catch {
        return otro(MENSAJE_DANADO_POR_EXTENSION[extensionDe(nombre)] ?? MENSAJE_ZIP_DANADO, 'application/zip')
      }
      if (clase === 'contenedor') return otro(MENSAJE_ZIP_ANIDADO, 'application/zip')
      if (clase === 'documento') return otro(PROBLEMA_FORMATO, 'application/zip')
    }

    // Lo que queda solo se puede leer entero: texto, Word o Excel.
    const conCabecera = leerArchivo(nombre, cabecera)
    if (conCabecera.tipo === 'otro' && cabecera.toString('latin1', 0, 4) !== 'PK\x03\x04') return conCabecera
    if (tamano > LIMITE_BYTES_PARA_TEXTO) return otro(MENSAJE_GRANDE_PARA_TEXTO, conCabecera.mime)
    return leerArchivo(nombre, await leerTramo(archivo, 0, tamano))
  } finally {
    await archivo.close()
  }
}

/** sha256 en hex de un archivo, sin cargarlo en memoria. */
export async function hashDeArchivo(ruta: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const parte of createReadStream(ruta)) hash.update(parte as Buffer)
  return hash.digest('hex')
}

/** Lee `largo` bytes desde `desde`. Devuelve menos solo si el archivo se termina antes. */
async function leerTramo(archivo: FileHandle, desde: number, largo: number): Promise<Buffer> {
  const datos = Buffer.alloc(largo)
  let leidos = 0
  while (leidos < largo) {
    const { bytesRead } = await archivo.read(datos, leidos, largo - leidos, desde + leidos)
    if (bytesRead === 0) break
    leidos += bytesRead
  }
  return leidos === largo ? datos : datos.subarray(0, leidos)
}

/** [ancho, alto] de una imagen según su encabezado, o null si no se pudo leer o no es JPEG, PNG, GIF ni WEBP. */
export function ladosDeImagen(datos: Buffer, mime: string): [number, number] | null {
  try {
    if (mime === 'image/jpeg') return ladosJpeg(datos)
    if (mime === 'image/png') return ladosPng(datos)
    if (mime === 'image/gif') return datos.length >= 10 ? [datos.readUInt16LE(6), datos.readUInt16LE(8)] : null
    if (mime === 'image/webp') return ladosWebp(datos)
  } catch {
    // Un encabezado cortado: no se sabe el tamaño y decide quien la use.
  }
  return null
}

function ladosPng(datos: Buffer): [number, number] | null {
  if (datos.length < 24 || datos.toString('latin1', 12, 16) !== 'IHDR') return null
  return [datos.readUInt32BE(16), datos.readUInt32BE(20)]
}

function ladosWebp(datos: Buffer): [number, number] | null {
  const formato = datos.toString('latin1', 12, 16)
  if (formato === 'VP8X' && datos.length >= 30) return [datos.readUIntLE(24, 3) + 1, datos.readUIntLE(27, 3) + 1]
  // Sin pérdida: 14 bits por lado, empaquetados después de la firma 0x2f.
  if (formato === 'VP8L' && datos.length >= 25 && datos[20] === 0x2f) {
    const bits = datos.readUInt32LE(21)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  // Con pérdida: después del código de inicio 9d 01 2a, 14 bits por lado.
  if (formato === 'VP8 ' && datos.length >= 30 && datos[23] === 0x9d && datos[24] === 0x01 && datos[25] === 0x2a) {
    return [datos.readUInt16LE(26) & 0x3fff, datos.readUInt16LE(28) & 0x3fff]
  }
  return null
}

/** El tamaño está en el marcador SOF, después de los metadatos: se saltan segmento por segmento. */
function ladosJpeg(datos: Buffer): [number, number] | null {
  let posicion = 2
  while (posicion + 9 < datos.length) {
    if (datos[posicion] !== 0xff) return null
    const marcador = datos[posicion + 1]
    // Relleno entre segmentos y marcadores sueltos, que no traen largo.
    if (marcador === 0xff) {
      posicion++
      continue
    }
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd9)) {
      posicion += 2
      continue
    }
    // C4 (tablas Huffman), C8 y CC no son cuadros aunque caigan en el rango de los SOF.
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
      return [datos.readUInt16BE(posicion + 7), datos.readUInt16BE(posicion + 5)]
    }
    posicion += 2 + datos.readUInt16BE(posicion + 2)
  }
  return null
}

function texto(mime: string, contenido: string, mensajeSiEstaVacio: string): ArchivoLeido {
  const limpio = contenido.replace(/^\n+/, '').replace(/\s+$/, '')
  if (limpio.trim() === '') return { tipo: 'texto', mime, texto: '', problema: mensajeSiEstaVacio }
  return { tipo: 'texto', mime, texto: recortar(limpio), problema: null }
}

function recortar(contenido: string): string {
  if (contenido.length <= LIMITE_CARACTERES) return contenido
  let corte = LIMITE_CARACTERES
  // Cortar entre las dos mitades de un emoji deja un carácter roto al final.
  const codigo = contenido.charCodeAt(corte - 1)
  if (codigo >= 0xd800 && codigo <= 0xdbff) corte--
  const total = contenido.length.toLocaleString('es-AR')
  const dejados = LIMITE_CARACTERES.toLocaleString('es-AR')
  return `${contenido.slice(0, corte)}\n\n[Se recortó el texto: tenía ${total} caracteres y se dejaron los primeros ${dejados}.]`
}

// ---------------------------------------------------------------------------------------------
// Texto plano
// ---------------------------------------------------------------------------------------------

function tieneBomUtf16(datos: Buffer): boolean {
  return (datos[0] === 0xff && datos[1] === 0xfe) || (datos[0] === 0xfe && datos[1] === 0xff)
}

function decodificarTexto(datos: Buffer): string {
  // Excel exporta «Texto Unicode» en UTF-16 con BOM: es la forma más común de sacar una lista de precios.
  if (datos[0] === 0xff && datos[1] === 0xfe) return limpiarTexto(new TextDecoder('utf-16le').decode(datos))
  if (datos[0] === 0xfe && datos[1] === 0xff) return limpiarTexto(new TextDecoder('utf-16be').decode(datos))
  try {
    // fatal y no buscar U+FFFD: un chat puede traer ese carácter legítimo y no por eso está en otra codificación.
    return limpiarTexto(new TextDecoder('utf-8', { fatal: true }).decode(datos))
  } catch {
    // Lo que no es UTF-8 válido casi siempre viene del Bloc de notas o de un Excel viejo de Windows.
    return limpiarTexto(new TextDecoder('windows-1252').decode(datos))
  }
}

function limpiarTexto(contenido: string): string {
  // WhatsApp mete marcas de dirección invisibles antes de adjuntos y nombres; ensucian las búsquedas y las citas.
  return contenido.replace(/\r\n?/g, '\n').replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
}

// ---------------------------------------------------------------------------------------------
// Contenedores zip: Word, Excel, y los .zip que se abren (el de WhatsApp o el de una carpeta)
// ---------------------------------------------------------------------------------------------

/**
 * 'docx' y 'xlsx' se leen como texto. 'documento': otro paquete de documento (PowerPoint,
 * OpenDocument, EPUB, Pages…) que por dentro es un zip pero no es una carpeta de archivos: abrirlo
 * daría una «conversación» llena de XML. 'contenedor': un .zip de verdad, que se abre.
 */
export type ClaseDeZip = 'docx' | 'xlsx' | 'documento' | 'contenedor'

function clasePorNombres(nombres: string[]): ClaseDeZip {
  const hay = new Set(nombres)
  if (hay.has('word/document.xml')) return 'docx'
  if (hay.has('xl/workbook.xml')) return 'xlsx'
  const esDocumento =
    hay.has('[Content_Types].xml') || // Office: PowerPoint, Visio y los demás
    hay.has('mimetype') || // OpenDocument y EPUB
    hay.has('META-INF/MANIFEST.MF') || // .jar
    hay.has('AndroidManifest.xml') || // .apk
    nombres.some((nombre) => /^Index\/.*\.iwa$/.test(nombre) || nombre === 'Index.zip') // Pages, Numbers y Keynote
  return esDocumento ? 'documento' : 'contenedor'
}

function leerContenedorZip(extension: string, datos: Buffer): ArchivoLeido {
  const mensajeDanado = MENSAJE_DANADO_POR_EXTENSION[extension] ?? MENSAJE_ZIP_DANADO
  try {
    const directorio = leerDirectorio(datos, mensajeDanado)
    const clase = clasePorNombres(directorio.map((entrada) => entrada.nombre))
    if (clase === 'docx') {
      const documento = directorio.find((entrada) => entrada.nombre === 'word/document.xml')!
      const xml = extraerEntrada(datos, documento, mensajeDanado).toString('utf8')
      return textoOProblema(texto(MIME_DOCX, limpiarTexto(textoDeDocx(xml)), MENSAJE_SIN_TEXTO.docx))
    }
    if (clase === 'xlsx') {
      // Solo las hojas y sus tablas: las fotos pegadas en el Excel no hacen falta para leer los datos.
      const partes = directorio.filter((entrada) => entrada.nombre.startsWith('xl/') && /\.(xml|rels)$/i.test(entrada.nombre))
      const entradas = extraerEntradas(datos, partes, mensajeDanado)
      return textoOProblema(texto(MIME_XLSX, limpiarTexto(textoDeXlsx(entradas)), MENSAJE_SIN_TEXTO.xlsx))
    }
    return otro(clase === 'documento' ? PROBLEMA_FORMATO : MENSAJE_ZIP_ANIDADO, 'application/zip')
  } catch (err) {
    // Cualquier lectura fuera de rango o deflate inválido significa lo mismo para el dueño: el archivo está roto.
    return otro(err instanceof ErrorArchivo ? err.message : mensajeDanado, 'application/zip')
  }
}

/** Un Word sin texto o un Excel sin datos no es «texto vacío»: es un archivo que no se pudo leer. */
function textoOProblema(leido: ArchivoLeido): ArchivoLeido {
  return leido.problema ? { ...leido, tipo: 'otro' } : leido
}

/** Todo el contenido de un .zip, en memoria. Para archivos chicos: Word, Excel y pruebas. */
export function leerZip(datos: Buffer): Map<string, Buffer> {
  try {
    return extraerEntradas(datos, leerDirectorio(datos, MENSAJE_ZIP_DANADO), MENSAJE_ZIP_DANADO)
  } catch (err) {
    if (err instanceof ErrorArchivo) throw err
    throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
  }
}

const FIRMA_FIN_DIRECTORIO = 0x06054b50
const FIRMA_FIN_DIRECTORIO_64 = 0x06064b50
const FIRMA_LOCALIZADOR_64 = 0x07064b50
const FIRMA_DIRECTORIO = 0x02014b50
const FIRMA_LOCAL = 0x04034b50
// 22 bytes del registro final más un comentario de hasta 65.535.
const BUSQUEDA_FIN_DIRECTORIO = 65_557
// Un directorio de 1.000 entradas con nombres largos no llega a 1 MB.
const LIMITE_BYTES_DIRECTORIO = 32 * 1024 * 1024
const LIMITE_ENTRADAS_DIRECTORIO = 100_000
const SIN_VALOR_32 = 0xffffffff
const SIN_VALOR_16 = 0xffff

interface EntradaDirectorio {
  /** Con «/» como separador. Nunca se usa como ruta en el disco. */
  nombre: string
  metodo: number
  cifrada: boolean
  esCarpeta: boolean
  /** Un enlace simbólico de Unix: su contenido es la ruta a otro archivo. No se saca. */
  esEnlace: boolean
  crc: number
  tamanoComprimido: number
  tamanoDescomprimido: number
  desplazamientoLocal: number
}

/** Dónde está el directorio central y cuántas entradas tiene. */
interface FinDeDirectorio {
  cantidad: number
  tamano: number
  desplazamiento: number
}

function leerEntero64(datos: Buffer, posicion: number): number {
  const valor = datos.readBigUInt64LE(posicion)
  if (valor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('número fuera de rango en el zip')
  return Number(valor)
}

/**
 * Las entradas del directorio central. `directorio` son solo sus bytes: vienen de memoria o del
 * disco. Lee también el formato ZIP64, que algunas herramientas usan aunque el archivo sea chico.
 */
function parsearDirectorio(directorio: Buffer, cantidad: number, mensajeDanado: string): EntradaDirectorio[] {
  if (cantidad > LIMITE_ENTRADAS_DIRECTORIO) throw new ErrorArchivo(MENSAJE_ZIP_MUCHOS)
  const entradas: EntradaDirectorio[] = []
  let posicion = 0

  for (let i = 0; i < cantidad; i++) {
    if (posicion + 46 > directorio.length || directorio.readUInt32LE(posicion) !== FIRMA_DIRECTORIO) throw new ErrorArchivo(mensajeDanado)
    const bandera = directorio.readUInt16LE(posicion + 8)
    const largoNombre = directorio.readUInt16LE(posicion + 28)
    const largoExtra = directorio.readUInt16LE(posicion + 30)
    const largoComentario = directorio.readUInt16LE(posicion + 32)
    const bytesNombre = directorio.subarray(posicion + 46, posicion + 46 + largoNombre)
    // El bit 11 avisa que el nombre está en UTF-8; sin él, la norma dice CP437 y latin1 es lo más parecido.
    const nombre = bytesNombre.toString(bandera & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/')

    let tamanoComprimido = directorio.readUInt32LE(posicion + 20)
    let tamanoDescomprimido = directorio.readUInt32LE(posicion + 24)
    let desplazamientoLocal = directorio.readUInt32LE(posicion + 42)
    if (tamanoComprimido === SIN_VALOR_32 || tamanoDescomprimido === SIN_VALOR_32 || desplazamientoLocal === SIN_VALOR_32) {
      // ZIP64: los valores que no entran en 32 bits van en el campo extra 0x0001, en este orden.
      const extra = directorio.subarray(posicion + 46 + largoNombre, posicion + 46 + largoNombre + largoExtra)
      let cursor = 0
      let encontrado = false
      while (cursor + 4 <= extra.length) {
        const id = extra.readUInt16LE(cursor)
        const largo = extra.readUInt16LE(cursor + 2)
        if (id === 0x0001) {
          let dentro = cursor + 4
          if (tamanoDescomprimido === SIN_VALOR_32) {
            tamanoDescomprimido = leerEntero64(extra, dentro)
            dentro += 8
          }
          if (tamanoComprimido === SIN_VALOR_32) {
            tamanoComprimido = leerEntero64(extra, dentro)
            dentro += 8
          }
          if (desplazamientoLocal === SIN_VALOR_32) desplazamientoLocal = leerEntero64(extra, dentro)
          encontrado = true
          break
        }
        cursor += 4 + largo
      }
      if (!encontrado) throw new ErrorArchivo(mensajeDanado)
    }

    // Los cuatro bits altos del modo de Unix dicen qué es: 0o12 es un enlace simbólico.
    const modo = directorio.readUInt32LE(posicion + 38) >>> 16
    entradas.push({
      nombre,
      metodo: directorio.readUInt16LE(posicion + 10),
      cifrada: (bandera & 0x1) !== 0,
      esCarpeta: nombre.endsWith('/'),
      esEnlace: (modo & 0o170000) === 0o120000,
      crc: directorio.readUInt32LE(posicion + 16),
      tamanoComprimido,
      tamanoDescomprimido,
      desplazamientoLocal,
    })
    posicion += 46 + largoNombre + largoExtra + largoComentario
  }
  return entradas
}

/**
 * Busca el registro de fin de directorio en `cola`, que son los últimos bytes del zip y empiezan
 * en la posición `base` del archivo. -1 si no está.
 */
function buscarFinDirectorio(cola: Buffer, base = 0): number {
  const limite = Math.max(0, cola.length - BUSQUEDA_FIN_DIRECTORIO)
  for (let i = cola.length - 22; i >= limite; i--) {
    if (cola.readUInt32LE(i) !== FIRMA_FIN_DIRECTORIO) continue
    const tamano = cola.readUInt32LE(i + 12)
    const desplazamiento = cola.readUInt32LE(i + 16)
    // La firma puede aparecer por casualidad dentro del comentario: solo vale si el directorio cae antes.
    if (desplazamiento === SIN_VALOR_32 || tamano === SIN_VALOR_32 || desplazamiento + tamano <= base + i) return i
  }
  return -1
}

/** Solo lo que se sabe sacar: ni carpetas, ni entradas con contraseña, ni métodos raros. */
function leerDirectorio(datos: Buffer, mensajeDanado: string): EntradaDirectorio[] {
  try {
    const fin = buscarFinDirectorio(datos)
    if (fin === -1) throw new ErrorArchivo(mensajeDanado)
    let lugar: FinDeDirectorio = {
      cantidad: datos.readUInt16LE(fin + 10),
      tamano: datos.readUInt32LE(fin + 12),
      desplazamiento: datos.readUInt32LE(fin + 16),
    }
    if (lugar.cantidad === SIN_VALOR_16 || lugar.tamano === SIN_VALOR_32 || lugar.desplazamiento === SIN_VALOR_32) {
      if (fin < 20 || datos.readUInt32LE(fin - 20) !== FIRMA_LOCALIZADOR_64) throw new ErrorArchivo(mensajeDanado)
      const registro = leerEntero64(datos, fin - 20 + 8)
      if (datos.readUInt32LE(registro) !== FIRMA_FIN_DIRECTORIO_64) throw new ErrorArchivo(mensajeDanado)
      lugar = {
        cantidad: leerEntero64(datos, registro + 32),
        tamano: leerEntero64(datos, registro + 40),
        desplazamiento: leerEntero64(datos, registro + 48),
      }
    }
    if (lugar.desplazamiento + lugar.tamano > datos.length) throw new ErrorArchivo(mensajeDanado)
    const directorio = datos.subarray(lugar.desplazamiento, lugar.desplazamiento + lugar.tamano)
    // Un método que no sabemos descomprimir o una entrada con contraseña no deberían tirar abajo todo el documento.
    return parsearDirectorio(directorio, lugar.cantidad, mensajeDanado).filter(
      (entrada) => !entrada.esCarpeta && !entrada.cifrada && (entrada.metodo === 0 || entrada.metodo === 8),
    )
  } catch (err) {
    if (err instanceof ErrorArchivo) throw err
    throw new ErrorArchivo(mensajeDanado)
  }
}

function extraerEntradas(datos: Buffer, entradas: EntradaDirectorio[], mensajeDanado: string): Map<string, Buffer> {
  const total = entradas.reduce((suma, entrada) => suma + entrada.tamanoDescomprimido, 0)
  if (total > LIMITE_BYTES_DESCOMPRIMIDOS) throw new ErrorArchivo(MENSAJE_ZIP_ENORME)
  const resultado = new Map<string, Buffer>()
  for (const entrada of entradas) resultado.set(entrada.nombre, extraerEntrada(datos, entrada, mensajeDanado))
  return resultado
}

function extraerEntrada(datos: Buffer, entrada: EntradaDirectorio, mensajeDanado: string): Buffer {
  try {
    const local = entrada.desplazamientoLocal
    if (datos.readUInt32LE(local) !== FIRMA_LOCAL) throw new ErrorArchivo(mensajeDanado)
    // Los largos del encabezado local pueden no coincidir con los del directorio (zipalign rellena el extra).
    const inicio = local + 30 + datos.readUInt16LE(local + 26) + datos.readUInt16LE(local + 28)
    const final = inicio + entrada.tamanoComprimido
    if (final > datos.length) throw new ErrorArchivo(mensajeDanado)
    const comprimido = datos.subarray(inicio, final)

    if (entrada.metodo === 0) {
      if (entrada.tamanoComprimido !== entrada.tamanoDescomprimido) throw new ErrorArchivo(mensajeDanado)
      return comprimido
    }

    // El tope es lo que declara la entrada: un zip bomb declara poco y descomprime gigas.
    const salida = inflateRawSync(comprimido, { maxOutputLength: Math.max(1, entrada.tamanoDescomprimido) })
    if (salida.length !== entrada.tamanoDescomprimido) throw new ErrorArchivo(mensajeDanado)
    return salida
  } catch (err) {
    if (err instanceof ErrorArchivo) throw err
    throw new ErrorArchivo(mensajeDanado)
  }
}

// ---------------------------------------------------------------------------------------------
// Zip desde el disco: se abre sin cargarlo en memoria
// ---------------------------------------------------------------------------------------------

async function directorioDeDisco(archivo: FileHandle, tamano: number): Promise<EntradaDirectorio[]> {
  try {
    const base = Math.max(0, tamano - BUSQUEDA_FIN_DIRECTORIO)
    const cola = await leerTramo(archivo, base, tamano - base)
    const fin = buscarFinDirectorio(cola, base)
    if (fin === -1) throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
    let lugar: FinDeDirectorio = {
      cantidad: cola.readUInt16LE(fin + 10),
      tamano: cola.readUInt32LE(fin + 12),
      desplazamiento: cola.readUInt32LE(fin + 16),
    }
    if (lugar.cantidad === SIN_VALOR_16 || lugar.tamano === SIN_VALOR_32 || lugar.desplazamiento === SIN_VALOR_32) {
      if (fin < 20 || cola.readUInt32LE(fin - 20) !== FIRMA_LOCALIZADOR_64) throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
      const registro = await leerTramo(archivo, leerEntero64(cola, fin - 20 + 8), 56)
      if (registro.length < 56 || registro.readUInt32LE(0) !== FIRMA_FIN_DIRECTORIO_64) throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
      lugar = { cantidad: leerEntero64(registro, 32), tamano: leerEntero64(registro, 40), desplazamiento: leerEntero64(registro, 48) }
    }
    if (lugar.tamano > LIMITE_BYTES_DIRECTORIO) throw new ErrorArchivo(MENSAJE_ZIP_MUCHOS)
    if (lugar.desplazamiento + lugar.tamano > tamano) throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
    const directorio = await leerTramo(archivo, lugar.desplazamiento, lugar.tamano)
    return parsearDirectorio(directorio, lugar.cantidad, MENSAJE_ZIP_DANADO)
  } catch (err) {
    if (err instanceof ErrorArchivo) throw err
    throw new ErrorArchivo(MENSAJE_ZIP_DANADO)
  }
}

async function claseDeZip(archivo: FileHandle, tamano: number): Promise<ClaseDeZip> {
  return clasePorNombres((await directorioDeDisco(archivo, tamano)).map((entrada) => entrada.nombre))
}

/** Qué clase de .zip es, leyendo solo su directorio. Tira ErrorArchivo si está dañado. */
export async function tipoDeZip(ruta: string): Promise<ClaseDeZip> {
  const archivo = await open(ruta, 'r')
  try {
    return await claseDeZip(archivo, (await archivo.stat()).size)
  } finally {
    await archivo.close()
  }
}

export interface ArchivoExpandido {
  /** Dónde quedó en el disco: <carpetaDestino>/<id>. */
  ruta: string
  /** El nombre con el que se guardó: un uuid, nunca el nombre que traía. */
  id: string
  /** La ruta que tenía adentro del .zip, con «/». Sirve para el nombre y para agrupar; nunca para escribir. */
  rutaEnZip: string
  bytes: number
}

export interface ZipExpandido {
  archivos: ArchivoExpandido[]
  /** Lo que no se pudo sacar, con el motivo. El resto del .zip se saca igual. */
  omitidos: { nombre: string; motivo: string }[]
}

/**
 * Saca a `carpetaDestino` todo lo que trae un .zip, una entrada a la vez y sin cargarlo en memoria.
 *
 * Cada archivo se guarda con un uuid: la ruta que trae adentro del zip nunca llega al disco, así
 * un «../../algo» no puede escribir afuera de la carpeta. Tira ErrorArchivo si el zip está
 * dañado, trae demasiadas entradas o lo que declara no entra en el espacio que queda.
 */
export async function expandirZip(
  ruta: string,
  carpetaDestino: string,
  { presupuestoBytes, maximoEntradas = 1000 }: { presupuestoBytes: number; maximoEntradas?: number },
): Promise<ZipExpandido> {
  const archivo = await open(ruta, 'r')
  const resultado: ZipExpandido = { archivos: [], omitidos: [] }
  try {
    const tamano = (await archivo.stat()).size
    const directorio = await directorioDeDisco(archivo, tamano)
    // Carpetas, entradas vacías, basura de Mac y de Windows, y enlaces: no son material de nadie.
    const entradas = directorio.filter(
      (entrada) => !entrada.esCarpeta && !entrada.esEnlace && entrada.tamanoDescomprimido > 0 && !esArchivoDeSistema(entrada.nombre),
    )
    if (entradas.length > maximoEntradas) throw new ErrorArchivo(MENSAJE_ZIP_MUCHOS)
    const declarado = entradas.reduce((suma, entrada) => suma + entrada.tamanoDescomprimido, 0)
    if (declarado > presupuestoBytes) {
      const megas = Math.max(0, Math.floor(presupuestoBytes / (1024 * 1024)))
      throw new ErrorArchivo(`Lo que hay adentro del .zip pasa el espacio que queda (${megas} MB). Subí las conversaciones de a una.`)
    }

    await mkdir(carpetaDestino, { recursive: true })
    for (const entrada of entradas) {
      if (entrada.cifrada) {
        resultado.omitidos.push({ nombre: entrada.nombre, motivo: 'cifrado' })
        continue
      }
      if (entrada.metodo !== 0 && entrada.metodo !== 8) {
        resultado.omitidos.push({ nombre: entrada.nombre, motivo: 'formato de compresión que no leemos' })
        continue
      }
      const id = randomUUID()
      const destino = join(carpetaDestino, id)
      if (await extraerADisco(archivo, ruta, tamano, entrada, destino)) {
        resultado.archivos.push({ ruta: destino, id, rutaEnZip: entrada.nombre, bytes: entrada.tamanoDescomprimido })
      } else {
        await rm(destino, { force: true })
        resultado.omitidos.push({ nombre: entrada.nombre, motivo: 'dañado' })
      }
    }
    return resultado
  } catch (err) {
    // Si el zip se corta a mitad de camino, lo que ya salió no puede quedar ocupando disco.
    await Promise.all(resultado.archivos.map((a) => rm(a.ruta, { force: true })))
    throw err
  } finally {
    await archivo.close()
  }
}

/**
 * Saca una entrada al disco. false si no mide exactamente lo que declara o no pasa el CRC: un
 * zip bomb declara poco y descomprime gigas, y uno cortado deja archivos a medias.
 */
async function extraerADisco(
  archivo: FileHandle,
  rutaZip: string,
  tamanoZip: number,
  entrada: EntradaDirectorio,
  destino: string,
): Promise<boolean> {
  const local = await leerTramo(archivo, entrada.desplazamientoLocal, 30)
  if (local.length < 30 || local.readUInt32LE(0) !== FIRMA_LOCAL) return false
  // Los largos del encabezado local pueden no coincidir con los del directorio (zipalign rellena el extra).
  const inicio = entrada.desplazamientoLocal + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  if (entrada.tamanoComprimido === 0 || inicio + entrada.tamanoComprimido > tamanoZip) return false
  if (entrada.metodo === 0 && entrada.tamanoComprimido !== entrada.tamanoDescomprimido) return false

  let bytes = 0
  let suma = 0
  const medir = new Transform({
    transform(parte: Buffer, _codificacion, listo) {
      bytes += parte.length
      if (bytes > entrada.tamanoDescomprimido) {
        listo(new Error('La entrada descomprime a más de lo que declara.'))
        return
      }
      suma = crc32(parte, suma)
      listo(null, parte)
    },
  })
  const origen = createReadStream(rutaZip, { start: inicio, end: inicio + entrada.tamanoComprimido - 1 })
  try {
    if (entrada.metodo === 8) await pipeline(origen, createInflateRaw(), medir, createWriteStream(destino))
    else await pipeline(origen, medir, createWriteStream(destino))
  } catch {
    return false
  }
  return bytes === entrada.tamanoDescomprimido && suma >>> 0 === entrada.crc
}

// ---------------------------------------------------------------------------------------------
// XML de Office
// ---------------------------------------------------------------------------------------------

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodificarEntidades(contenido: string): string {
  return contenido.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (entera, hex, dec, nombre) => {
    if (nombre) return ENTIDADES[nombre]
    const codigo = hex ? parseInt(hex, 16) : parseInt(dec, 10)
    return codigo <= 0x10ffff ? String.fromCodePoint(codigo) : entera
  })
}

function leerAtributos(etiqueta: string): Map<string, string> {
  const atributos = new Map<string, string>()
  for (const [, nombre, dobles, simples] of etiqueta.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    atributos.set(nombre, decodificarEntidades(dobles ?? simples ?? ''))
  }
  return atributos
}

// Word (y todo lo que exporta a .docx) usa el prefijo w:. Solo interesan párrafos, tablas y texto.
const TOKEN_DOCX = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<(\/?)w:(p|tbl|tr|tc|tab|br|cr)(\s[^>]*?)?(\/?)>/g

interface TablaDocx {
  fila: string[] | null
  celda: string[] | null
}

function textoDeDocx(xml: string): string {
  // Los cuadros de texto vienen dos veces: la versión moderna y un respaldo VML. Sin esto se duplica el texto.
  const limpio = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')
  const lineas: string[] = []
  const tablas: TablaDocx[] = []
  let parrafo = ''

  // Una tabla adentro de una celda manda sus filas a esa celda y no al documento.
  const agregar = (nivel: number, contenido: string) => {
    const celda = tablas[nivel]?.celda
    if (celda) celda.push(contenido)
    else lineas.push(contenido)
  }

  for (const [, contenidoTexto, cierre, etiqueta, atributos, autocierre] of limpio.matchAll(TOKEN_DOCX)) {
    const tabla = tablas[tablas.length - 1]
    if (contenidoTexto !== undefined) {
      parrafo += decodificarEntidades(contenidoTexto)
    } else if (etiqueta === 'tab') {
      // Con atributos es una parada de tabulación del formato del párrafo, no un tab escrito.
      if (!atributos?.trim()) parrafo += '\t'
    } else if (etiqueta === 'br' || etiqueta === 'cr') {
      parrafo += '\n'
    } else if (etiqueta === 'p') {
      // Un párrafo que abre con texto pendiente es un cuadro de texto adentro de otro: sin cortar, se pegan.
      if (autocierre || cierre || parrafo) {
        agregar(tablas.length - 1, parrafo)
        parrafo = ''
      }
    } else if (etiqueta === 'tbl') {
      if (autocierre) continue
      if (cierre) tablas.pop()
      else tablas.push({ fila: null, celda: null })
    } else if (tabla && etiqueta === 'tr' && !autocierre) {
      if (!cierre) tabla.fila = []
      else if (tabla.fila) {
        agregar(tablas.length - 2, tabla.fila.join('\t').replace(/\s+$/, ''))
        tabla.fila = null
      }
    } else if (tabla && etiqueta === 'tc') {
      if (autocierre) tabla.fila?.push('')
      else if (!cierre) tabla.celda = []
      else if (tabla.celda) {
        // Cada fila va en una línea con tabs entre celdas: los saltos adentro de una celda la partirían.
        tabla.fila?.push(tabla.celda.join(' ').replace(/\s+/g, ' ').trim())
        tabla.celda = null
      }
    }
  }
  if (parrafo) lineas.push(parrafo)
  return lineas.join('\n').replace(/\n{3,}/g, '\n\n')
}

function sinPrefijos(xml: string): string {
  // El SDK de OpenXML de Microsoft escribe <x:row> en vez de <row>; el resto de los generadores, sin prefijo.
  return xml.replace(/<(\/?)[\w.-]+:/g, '<$1')
}

function decodificarTextoExcel(contenido: string): string {
  // Excel guarda como _x000D_ los caracteres que el XML no admite, y _x005F_ para escribir un guion bajo literal.
  return decodificarEntidades(contenido).replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

function textosDe(xml: string): string {
  // Las guías fonéticas japonesas (rPh) repiten el texto con otra escritura.
  const sinFonetica = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  return [...sinFonetica.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(([, t]) => decodificarTextoExcel(t)).join('')
}

function resolverRuta(carpeta: string, destino: string): string {
  if (destino.startsWith('/')) return destino.slice(1)
  const partes = carpeta.split('/')
  for (const parte of destino.split('/')) {
    if (parte === '..') partes.pop()
    else if (parte !== '.' && parte !== '') partes.push(parte)
  }
  return partes.join('/')
}

function textoDeXlsx(entradas: Map<string, Buffer>): string {
  const leer = (ruta: string) => {
    const contenido = entradas.get(ruta)
    return contenido ? sinPrefijos(contenido.toString('utf8')) : ''
  }

  const libro = leer('xl/workbook.xml')
  const rutas = new Map<string, string>()
  for (const [etiqueta] of leer('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const atributos = leerAtributos(etiqueta)
    const id = atributos.get('Id')
    const destino = atributos.get('Target')
    if (id && destino) rutas.set(id, resolverRuta('xl', destino))
  }

  const cadenas = leer('xl/sharedStrings.xml').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)
  const compartidos = Array.from(cadenas, ([, si]) => (si ? textosDe(si) : ''))
  const fechas = estilosDeFecha(leer('xl/styles.xml'))
  const es1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(libro)

  const bloques: string[] = []
  const hojas = [...libro.matchAll(/<sheet\b[^>]*>/g)]
  hojas.forEach(([etiqueta], indice) => {
    const atributos = leerAtributos(etiqueta)
    const id = [...atributos].find(([clave]) => clave === 'r:id' || clave.endsWith(':id'))?.[1]
    // Sin relaciones, Excel igual numera las hojas en orden: es el mejor intento antes de perderlas.
    const ruta = (id && rutas.get(id)) || `xl/worksheets/sheet${indice + 1}.xml`
    const filas = filasDeHoja(leer(ruta), compartidos, fechas, es1904)
    if (filas.length > 0) bloques.push(`## Hoja: ${atributos.get('name') ?? `Hoja ${indice + 1}`}\n${filas.join('\n')}`)
  })
  return bloques.join('\n\n')
}

function filasDeHoja(xml: string, compartidos: string[], fechas: Set<number>, es1904: boolean): string[] {
  const filas: string[][] = []
  // Muchas planillas dejan columnas de margen a la izquierda: arrancar desde la A llenaría todo de tabs.
  let primeraColumna = Infinity

  for (const [, contenidoFila] of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!contenidoFila) continue
    const valores: string[] = []
    let columna = -1
    for (const [, etiquetaCelda, contenidoCelda] of contenidoFila.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributos = leerAtributos(etiquetaCelda)
      const referencia = atributos.get('r')
      columna = referencia ? indiceDeColumna(referencia) : columna + 1
      const valor = valorDeCelda(atributos, contenidoCelda ?? '', compartidos, fechas, es1904)
      // Cada fila va en una línea y las columnas se separan con tab: adentro de una celda no pueden quedar.
      valores[columna] = valor.replace(/\s+/g, ' ').trim()
    }
    const usadas = valores.flatMap((valor, i) => (valor ? [i] : []))
    if (usadas.length === 0) continue
    primeraColumna = Math.min(primeraColumna, usadas[0])
    filas.push(valores.slice(0, usadas[usadas.length - 1] + 1))
  }
  return filas.map((valores) => Array.from(valores.slice(primeraColumna), (valor) => valor ?? '').join('\t'))
}

function indiceDeColumna(referencia: string): number {
  const letras = /^[A-Za-z]+/.exec(referencia)?.[0].toUpperCase() ?? 'A'
  return [...letras].reduce((indice, letra) => indice * 26 + letra.charCodeAt(0) - 64, 0) - 1
}

function valorDeCelda(
  atributos: Map<string, string>,
  contenido: string,
  compartidos: string[],
  fechas: Set<number>,
  es1904: boolean,
): string {
  const tipo = atributos.get('t') ?? 'n'
  if (tipo === 'inlineStr') return textosDe(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(contenido)?.[1] ?? '')

  const crudo = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(contenido)?.[1]
  if (crudo === undefined) return ''
  if (tipo === 's') return compartidos[parseInt(crudo, 10)] ?? ''
  // El dueño ve VERDADERO y FALSO en su Excel en castellano.
  if (tipo === 'b') return crudo === '1' ? 'VERDADERO' : 'FALSO'
  if (tipo !== 'n') return decodificarTextoExcel(crudo)

  const numero = Number(crudo)
  if (!Number.isFinite(numero)) return decodificarTextoExcel(crudo)
  if (fechas.has(parseInt(atributos.get('s') ?? '0', 10))) return fechaDeSerie(numero, es1904)
  // Excel guarda 0.30000000000000004 donde el dueño ve 0,3.
  return String(parseFloat(numero.toPrecision(15)))
}

// Formatos de fecha y hora que Excel trae de fábrica y no escribe en styles.xml.
const FORMATOS_FECHA_INTEGRADOS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
])

/** Índices de estilo de celda que muestran fecha. Sin esto, una fecha llega como 45292 y se confunde con un precio. */
function estilosDeFecha(estilos: string): Set<number> {
  const personalizados = new Map<number, string>()
  for (const [etiqueta] of estilos.matchAll(/<numFmt\b[^>]*>/g)) {
    const atributos = leerAtributos(etiqueta)
    personalizados.set(parseInt(atributos.get('numFmtId') ?? '-1', 10), atributos.get('formatCode') ?? '')
  }

  const indices = new Set<number>()
  const celdas = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(estilos)?.[1] ?? ''
  let indice = 0
  for (const [etiqueta] of celdas.matchAll(/<xf\b[^>]*>/g)) {
    const formato = parseInt(leerAtributos(etiqueta).get('numFmtId') ?? '0', 10)
    const codigo = personalizados.get(formato)
    if (codigo !== undefined ? esCodigoDeFecha(codigo) : FORMATOS_FECHA_INTEGRADOS.has(formato)) indices.add(indice)
    indice++
  }
  return indices
}

function esCodigoDeFecha(codigo: string): boolean {
  // Afuera: textos entre comillas, colores y monedas entre corchetes, y los caracteres escapados o de relleno.
  const sinLiterales = codigo.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '')
  return /[dmyhs]/i.test(sinLiterales)
}

function fechaDeSerie(serie: number, es1904: boolean): string {
  // 25569 es el 1/1/1970 en la cuenta de Excel, que ya incluye su 29/2/1900 inexistente.
  const minutos = Math.round((serie + (es1904 ? 1462 : 0) - 25569) * 1440)
  const fecha = new Date(minutos * 60_000)
  const dos = (n: number) => String(n).padStart(2, '0')
  const hora = `${dos(fecha.getUTCHours())}:${dos(fecha.getUTCMinutes())}`
  if (serie < 1) return hora
  const dia = `${dos(fecha.getUTCDate())}/${dos(fecha.getUTCMonth() + 1)}/${fecha.getUTCFullYear()}`
  return hora === '00:00' ? dia : `${dia} ${hora}`
}
