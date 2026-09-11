import { inflateRawSync } from 'node:zlib'

export const LIMITE_BYTES_ARCHIVO = 20 * 1024 * 1024

/** Igual que en `lib/motor/tipos.ts`. Se repite para que leer archivos no dependa del motor: si cambia uno, cambiá el otro. */
export type TipoMaterial = 'imagen' | 'pdf' | 'texto'

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
  /** null para imagen y pdf: los transcribe Claude después. */
  texto: string | null
}

// Un chat de meses entra de sobra; más que esto encarece cada llamada a Claude sin sumar.
const LIMITE_CARACTERES = 300_000
// Un .zip de 20 MB con fotos no llega ni cerca; pasarlo es señal de un zip armado para tumbar el servidor.
const LIMITE_BYTES_DESCOMPRIMIDOS = 200 * 1024 * 1024
// Alcanza para ver si es binario sin recorrer un archivo de 20 MB.
const BYTES_PARA_DETECTAR_TEXTO = 8 * 1024

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const MENSAJE_VACIO = 'El archivo está vacío. Volvé a guardarlo o exportarlo y subilo de nuevo.'
const MENSAJE_PESADO =
  'El archivo pesa más de 20 MB. Subí solo la parte que importa o partilo en archivos más chicos.'
const MENSAJE_HEIC = 'Las fotos HEIC del iPhone no se pueden leer. Mandá una captura de pantalla o exportala como JPG.'
const MENSAJE_AUDIO_VIDEO = 'No se aceptan audios ni videos. Escribí o pegá el texto.'
const MENSAJE_OFFICE_VIEJO =
  'Los archivos .doc y .xls (Word y Excel viejos) o con contraseña no se pueden leer. Abrilo, guardalo como .docx o .xlsx sin contraseña y subí ese.'
const MENSAJE_FORMATOS =
  'Ese tipo de archivo no se puede leer. Se aceptan imágenes (JPG, PNG, WEBP, GIF), PDF, Word (.docx), Excel (.xlsx), texto (.txt, .csv, .md) y el .zip que exporta WhatsApp.'
const MENSAJE_ZIP_SIN_CHAT =
  'Del archivo .zip solo se lee el chat en texto (.txt), y este no tiene ninguno. Volvé a exportar el chat desde WhatsApp o pegá el texto.'
const MENSAJE_ZIP_DANADO = 'El archivo .zip está dañado. Volvé a exportarlo y subilo de nuevo.'
const MENSAJE_ZIP_ENORME =
  'El archivo descomprimido pesa más de 200 MB. Subí solo lo que importa: si es un chat de WhatsApp, exportalo sin archivos multimedia.'

// Word y Excel también son .zip por dentro: sin esto, el dueño que sube un .docx roto lee que su «.zip» está dañado.
const MENSAJE_DANADO_POR_EXTENSION: Record<string, string> = {
  docx: 'El archivo de Word está dañado. Abrilo, guardalo de nuevo y volvé a subirlo.',
  xlsx: 'El archivo de Excel está dañado. Abrilo, guardalo de nuevo y volvé a subirlo.',
}

const MENSAJE_SIN_TEXTO: Record<'docx' | 'xlsx' | 'chat', string> = {
  docx: 'El Word no tiene texto para leer: puede que tenga solo fotos pegadas. Guardalo como PDF y subí ese.',
  xlsx: 'El Excel no tiene celdas con datos. Revisá que sea el archivo correcto y volvé a subirlo.',
  chat: 'El chat del .zip está vacío. Volvé a exportarlo desde WhatsApp y subilo de nuevo.',
}

function mensajeExtensionFalsa(extension: string): string {
  return `El archivo dice ser .${extension} pero por dentro no lo es o está dañado. Abrilo en tu compu o celular, guardalo de nuevo y volvé a subirlo.`
}

const EXTENSIONES_TEXTO = new Set(['txt', 'csv', 'tsv', 'md', 'json'])
const EXTENSIONES_AUDIO_VIDEO = new Set([
  'opus', 'ogg', 'oga', 'm4a', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'aac', 'flac', 'amr', '3gp', 'avi', 'mkv', 'mpeg', 'wma',
])
const EXTENSIONES_HEIC = new Set(['heic', 'heif'])
const EXTENSIONES_OFFICE_VIEJO = new Set(['doc', 'xls', 'ppt'])
// Las que se aceptan por firma: si llegan hasta el final sin coincidir, el archivo miente o está roto.
const EXTENSIONES_BINARIAS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'zip'])

const MARCAS_HEIC = new Set(['heic', 'heix', 'hevc', 'mif1', 'msf1'])
// Marcas de ISO BMFF que usan los audios y videos: celulares, WhatsApp y QuickTime.
const MARCAS_AUDIO_VIDEO = new Set(['M4A ', 'M4B ', 'M4V ', 'M4P ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  ', 'dash', 'avc1'])
// Sincronía de cuadro de MP3 y AAC. FF FE queda afuera a propósito: es el BOM de un texto UTF-16.
const SEGUNDO_BYTE_MPEG = new Set([0xfb, 0xfa, 0xf3, 0xf2, 0xf1, 0xf9])

export function leerArchivo(nombre: string, datos: Buffer): ArchivoLeido {
  if (datos.length === 0) throw new ErrorArchivo(MENSAJE_VACIO)
  if (datos.length > LIMITE_BYTES_ARCHIVO) throw new ErrorArchivo(MENSAJE_PESADO)

  const extension = /\.([^./\\]+)$/.exec(nombre)?.[1].toLowerCase() ?? ''
  const inicio = datos.toString('latin1', 0, 12)

  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return binario('imagen', 'image/jpeg')
  if (inicio.startsWith('\x89PNG')) return binario('imagen', 'image/png')
  if (inicio.startsWith('GIF8')) return binario('imagen', 'image/gif')
  if (inicio.startsWith('RIFF') && inicio.slice(8, 12) === 'WEBP') return binario('imagen', 'image/webp')
  // La norma de PDF permite basura antes del encabezado; solo se busca más adentro si dice ser PDF.
  if (inicio.startsWith('%PDF') || (extension === 'pdf' && datos.subarray(0, 1024).includes('%PDF'))) {
    return binario('pdf', 'application/pdf')
  }

  if (inicio.slice(4, 8) === 'ftyp') {
    const marca = inicio.slice(8, 12)
    if (MARCAS_HEIC.has(marca)) throw new ErrorArchivo(MENSAJE_HEIC)
    if (MARCAS_AUDIO_VIDEO.has(marca) || marca.startsWith('3g')) throw new ErrorArchivo(MENSAJE_AUDIO_VIDEO)
  }
  if (esAudioOVideo(datos, inicio)) throw new ErrorArchivo(MENSAJE_AUDIO_VIDEO)

  if (inicio.startsWith('PK\x03\x04')) return leerContenedorZip(extension, datos)
  // Formato compuesto de Office: lo usan los .doc y .xls viejos y los .docx con contraseña.
  if (inicio.startsWith('\xd0\xcf\x11\xe0')) throw new ErrorArchivo(MENSAJE_OFFICE_VIEJO)

  if (EXTENSIONES_HEIC.has(extension)) throw new ErrorArchivo(MENSAJE_HEIC)
  if (EXTENSIONES_AUDIO_VIDEO.has(extension)) throw new ErrorArchivo(MENSAJE_AUDIO_VIDEO)
  if (EXTENSIONES_OFFICE_VIEJO.has(extension)) throw new ErrorArchivo(MENSAJE_OFFICE_VIEJO)

  const pareceTexto = tieneBomUtf16(datos) || !datos.subarray(0, BYTES_PARA_DETECTAR_TEXTO).includes(0)
  if (EXTENSIONES_TEXTO.has(extension)) {
    if (!pareceTexto) throw new ErrorArchivo(mensajeExtensionFalsa(extension))
    return texto(extension === 'csv' ? 'text/csv' : 'text/plain', decodificarTexto(datos), MENSAJE_VACIO)
  }
  if (EXTENSIONES_BINARIAS.has(extension)) throw new ErrorArchivo(mensajeExtensionFalsa(extension))
  if (pareceTexto) return texto('text/plain', decodificarTexto(datos), MENSAJE_VACIO)

  throw new ErrorArchivo(MENSAJE_FORMATOS)
}

function binario(tipo: 'imagen' | 'pdf', mime: string): ArchivoLeido {
  return { tipo, mime, texto: null }
}

function texto(mime: string, contenido: string, mensajeSiEstaVacio: string): ArchivoLeido {
  const limpio = contenido.replace(/^\n+/, '').replace(/\s+$/, '')
  if (limpio.trim() === '') throw new ErrorArchivo(mensajeSiEstaVacio)
  return { tipo: 'texto', mime, texto: recortar(limpio) }
}

function esAudioOVideo(datos: Buffer, inicio: string): boolean {
  // Con el byte de versión: un .csv puede arrancar con «ID3» si es el código de un producto.
  if (inicio.startsWith('ID3') && datos[3] <= 4 && datos[4] === 0) return true
  if ((inicio.startsWith('OggS') && datos[4] === 0) || inicio.startsWith('fLaC')) return true
  if (inicio.startsWith('RIFF') && ['WAVE', 'AVI '].includes(inicio.slice(8, 12))) return true
  if (datos[0] === 0x1a && datos[1] === 0x45 && datos[2] === 0xdf && datos[3] === 0xa3) return true
  return datos[0] === 0xff && SEGUNDO_BYTE_MPEG.has(datos[1])
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
  return contenido.replace(/\r\n?/g, '\n').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
}

// ---------------------------------------------------------------------------------------------
// Contenedores zip: Word, Excel y export de WhatsApp
// ---------------------------------------------------------------------------------------------

function leerContenedorZip(extension: string, datos: Buffer): ArchivoLeido {
  const entradas = abrirZip(datos, MENSAJE_DANADO_POR_EXTENSION[extension] ?? MENSAJE_ZIP_DANADO)

  const documento = entradas.get('word/document.xml')
  if (documento) {
    return texto(MIME_DOCX, limpiarTexto(textoDeDocx(documento.toString('utf8'))), MENSAJE_SIN_TEXTO.docx)
  }
  if (entradas.has('xl/workbook.xml')) {
    return texto(MIME_XLSX, limpiarTexto(textoDeXlsx(entradas)), MENSAJE_SIN_TEXTO.xlsx)
  }

  const chats = [...entradas].filter(([nombre]) => esTxtDeVerdad(nombre))
  if (chats.length === 0) {
    // Un .pptx o un .odt también son zip: decirle que exporte WhatsApp no le serviría de nada.
    throw new ErrorArchivo(extension === 'zip' ? MENSAJE_ZIP_SIN_CHAT : MENSAJE_FORMATOS)
  }
  const partes = chats.map(([nombre, contenido]) =>
    chats.length > 1 ? `### ${nombre}\n${decodificarTexto(contenido).trim()}` : decodificarTexto(contenido),
  )
  return texto('application/zip', partes.join('\n\n'), MENSAJE_SIN_TEXTO.chat)
}

function esTxtDeVerdad(nombre: string): boolean {
  // Los .zip armados en Mac traen copias «._chat.txt» con metadatos binarios que no son el chat.
  const base = nombre.slice(nombre.lastIndexOf('/') + 1)
  return nombre.toLowerCase().endsWith('.txt') && !nombre.startsWith('__MACOSX/') && !base.startsWith('._')
}

export function leerZip(datos: Buffer): Map<string, Buffer> {
  return abrirZip(datos, MENSAJE_ZIP_DANADO)
}

const FIRMA_FIN_DIRECTORIO = 0x06054b50
const FIRMA_DIRECTORIO = 0x02014b50
const FIRMA_LOCAL = 0x04034b50
// 22 bytes del registro final más un comentario de hasta 65.535.
const BUSQUEDA_FIN_DIRECTORIO = 65_557

interface EntradaDirectorio {
  nombre: string
  metodo: number
  tamanoComprimido: number
  tamanoDescomprimido: number
  desplazamientoLocal: number
}

function abrirZip(datos: Buffer, mensajeDanado: string): Map<string, Buffer> {
  try {
    const entradas = leerDirectorio(datos, mensajeDanado)
    const total = entradas.reduce((suma, entrada) => suma + entrada.tamanoDescomprimido, 0)
    if (total > LIMITE_BYTES_DESCOMPRIMIDOS) throw new ErrorArchivo(MENSAJE_ZIP_ENORME)

    const resultado = new Map<string, Buffer>()
    for (const entrada of entradas) resultado.set(entrada.nombre, extraerEntrada(datos, entrada, mensajeDanado))
    return resultado
  } catch (err) {
    if (err instanceof ErrorArchivo) throw err
    // Cualquier lectura fuera de rango o deflate inválido significa lo mismo para el dueño: el archivo está roto.
    throw new ErrorArchivo(mensajeDanado)
  }
}

function leerDirectorio(datos: Buffer, mensajeDanado: string): EntradaDirectorio[] {
  const fin = buscarFinDirectorio(datos)
  if (fin === -1) throw new ErrorArchivo(mensajeDanado)

  const cantidad = datos.readUInt16LE(fin + 10)
  let posicion = datos.readUInt32LE(fin + 16)
  const entradas: EntradaDirectorio[] = []

  for (let i = 0; i < cantidad; i++) {
    if (datos.readUInt32LE(posicion) !== FIRMA_DIRECTORIO) throw new ErrorArchivo(mensajeDanado)
    const bandera = datos.readUInt16LE(posicion + 8)
    const metodo = datos.readUInt16LE(posicion + 10)
    const largoNombre = datos.readUInt16LE(posicion + 28)
    const largoExtra = datos.readUInt16LE(posicion + 30)
    const largoComentario = datos.readUInt16LE(posicion + 32)
    const bytesNombre = datos.subarray(posicion + 46, posicion + 46 + largoNombre)
    // El bit 11 avisa que el nombre está en UTF-8; sin él, la norma dice CP437 y latin1 es lo más parecido.
    const nombre = bytesNombre.toString(bandera & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/')

    const esCarpeta = nombre.endsWith('/')
    const cifrada = (bandera & 0x1) !== 0
    // Un método que no sabemos descomprimir o una entrada con contraseña no deberían tirar abajo todo el chat.
    if (!esCarpeta && !cifrada && (metodo === 0 || metodo === 8)) {
      entradas.push({
        nombre,
        metodo,
        tamanoComprimido: datos.readUInt32LE(posicion + 20),
        tamanoDescomprimido: datos.readUInt32LE(posicion + 24),
        desplazamientoLocal: datos.readUInt32LE(posicion + 42),
      })
    }
    posicion += 46 + largoNombre + largoExtra + largoComentario
  }
  return entradas
}

function buscarFinDirectorio(datos: Buffer): number {
  const limite = Math.max(0, datos.length - BUSQUEDA_FIN_DIRECTORIO)
  for (let i = datos.length - 22; i >= limite; i--) {
    if (datos.readUInt32LE(i) !== FIRMA_FIN_DIRECTORIO) continue
    // La firma puede aparecer por casualidad dentro del comentario: solo vale si el directorio cae antes.
    const tamano = datos.readUInt32LE(i + 12)
    const desplazamiento = datos.readUInt32LE(i + 16)
    if (desplazamiento + tamano <= i) return i
  }
  return -1
}

function extraerEntrada(datos: Buffer, entrada: EntradaDirectorio, mensajeDanado: string): Buffer {
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

  let salida: Buffer
  try {
    // El tope es lo que declara la entrada: un zip bomb declara poco y descomprime gigas.
    salida = inflateRawSync(comprimido, { maxOutputLength: Math.max(1, entrada.tamanoDescomprimido) })
  } catch {
    throw new ErrorArchivo(mensajeDanado)
  }
  if (salida.length !== entrada.tamanoDescomprimido) throw new ErrorArchivo(mensajeDanado)
  return salida
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
