import { crc32, deflateRawSync } from 'node:zlib'

/*
 * Escritor de zip mínimo para las pruebas: alcanza para armar en memoria los archivos que hacen
 * falta (el .zip que exporta WhatsApp, un Word, un zip roto a propósito) sin subir binarios al
 * repositorio. Todo lo que se arma con esto es inventado.
 */

export interface EntradaZip {
  nombre: string
  contenido: string | Buffer
  /** Método 0, sin comprimir. */
  guardada?: boolean
  /** Tamaño descomprimido que se declara, para simular un zip bomb o una entrada cortada. */
  tamanoDeclarado?: number
  /** Nombre en latin1 y sin el bit 11 de UTF-8. */
  nombreLatin1?: boolean
  /** Marca la entrada como cifrada (bit 0), sin cifrarla de verdad. */
  cifrada?: boolean
  /** Declara otro método de compresión (por ejemplo 12, bzip2). */
  metodo?: number
  /** La declara como enlace simbólico de Unix. */
  enlace?: boolean
  /** Escribe un CRC que no corresponde al contenido. */
  crcMalo?: boolean
}

export interface OpcionesZip {
  /** Escribe tamaños y posiciones en el formato ZIP64, como hacen algunas herramientas aunque el archivo sea chico. */
  zip64?: boolean
}

function entero64(valor: number): Buffer {
  const datos = Buffer.alloc(8)
  datos.writeBigUInt64LE(BigInt(valor))
  return datos
}

export function armarZip(entradas: EntradaZip[], opciones: OpcionesZip = {}): Buffer {
  const partes: Buffer[] = []
  const directorio: Buffer[] = []
  // Relleno en el encabezado local que el directorio no tiene, como hace zipalign en Android.
  const extraLocal = Buffer.from([0xfe, 0xca, 0x00, 0x00])
  let desplazamiento = 0

  for (const entrada of entradas) {
    const datos = typeof entrada.contenido === 'string' ? Buffer.from(entrada.contenido, 'utf8') : entrada.contenido
    const comprimidos = entrada.guardada ? datos : deflateRawSync(datos)
    const nombre = Buffer.from(entrada.nombre, entrada.nombreLatin1 ? 'latin1' : 'utf8')
    const bandera = (entrada.nombreLatin1 ? 0 : 0x0800) | (entrada.cifrada ? 1 : 0)
    const metodo = entrada.metodo ?? (entrada.guardada ? 0 : 8)
    const crc = entrada.crcMalo ? 0x12345678 : crc32(datos)
    const tamano = entrada.tamanoDeclarado ?? datos.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(bandera, 6)
    local.writeUInt16LE(metodo, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comprimidos.length, 18)
    local.writeUInt32LE(tamano, 22)
    local.writeUInt16LE(nombre.length, 26)
    local.writeUInt16LE(extraLocal.length, 28)
    partes.push(local, nombre, extraLocal, comprimidos)

    // En ZIP64 los tres valores van en el campo extra 0x0001 y en su lugar queda 0xFFFFFFFF.
    const extra = opciones.zip64
      ? Buffer.concat([Buffer.from([0x01, 0x00, 24, 0]), entero64(tamano), entero64(comprimidos.length), entero64(desplazamiento)])
      : Buffer.alloc(0)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    // «Hecho en Unix» (3) cuando es un enlace: ahí es donde valen los permisos.
    central.writeUInt16LE(entrada.enlace ? 0x0314 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(bandera, 8)
    central.writeUInt16LE(metodo, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(opciones.zip64 ? 0xffffffff : comprimidos.length, 20)
    central.writeUInt32LE(opciones.zip64 ? 0xffffffff : tamano, 24)
    central.writeUInt16LE(nombre.length, 28)
    central.writeUInt16LE(extra.length, 30)
    if (entrada.enlace) central.writeUInt32LE((0o120777 << 16) >>> 0, 38)
    central.writeUInt32LE(opciones.zip64 ? 0xffffffff : desplazamiento, 42)
    directorio.push(central, nombre, extra)

    desplazamiento += local.length + nombre.length + extraLocal.length + comprimidos.length
  }

  const bytesDirectorio = Buffer.concat(directorio)
  const finales: Buffer[] = []
  if (opciones.zip64) {
    const registro = Buffer.alloc(56)
    registro.writeUInt32LE(0x06064b50, 0)
    registro.writeBigUInt64LE(44n, 4)
    registro.writeUInt16LE(45, 12)
    registro.writeUInt16LE(45, 14)
    registro.writeBigUInt64LE(BigInt(entradas.length), 24)
    registro.writeBigUInt64LE(BigInt(entradas.length), 32)
    registro.writeBigUInt64LE(BigInt(bytesDirectorio.length), 40)
    registro.writeBigUInt64LE(BigInt(desplazamiento), 48)
    const localizador = Buffer.alloc(20)
    localizador.writeUInt32LE(0x07064b50, 0)
    localizador.writeBigUInt64LE(BigInt(desplazamiento + bytesDirectorio.length), 8)
    localizador.writeUInt32LE(1, 16)
    finales.push(registro, localizador)
  }
  // Con comentario, para que la búsqueda del final del directorio no pueda asumir que está en los últimos 22 bytes.
  const comentario = Buffer.from('zip de prueba')
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(opciones.zip64 ? 0xffff : entradas.length, 8)
  fin.writeUInt16LE(opciones.zip64 ? 0xffff : entradas.length, 10)
  fin.writeUInt32LE(opciones.zip64 ? 0xffffffff : bytesDirectorio.length, 12)
  fin.writeUInt32LE(opciones.zip64 ? 0xffffffff : desplazamiento, 16)
  fin.writeUInt16LE(comentario.length, 20)
  return Buffer.concat([...partes, bytesDirectorio, ...finales, fin, comentario])
}

export const TIPOS_CONTENIDO =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

export function armarDocx(cuerpo: string): Buffer {
  return armarZip([
    { nombre: '[Content_Types].xml', contenido: TIPOS_CONTENIDO, guardada: true },
    {
      nombre: 'word/document.xml',
      contenido:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${cuerpo}<w:sectPr/></w:body></w:document>`,
    },
  ])
}

// Cabeceras mínimas: alcanzan para que el servidor reconozca el tipo por la firma. No son archivos que se puedan abrir.
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
export const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
export const AUDIO_OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2]), Buffer.alloc(58, 7)])
export const VIDEO_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(60, 3)])
