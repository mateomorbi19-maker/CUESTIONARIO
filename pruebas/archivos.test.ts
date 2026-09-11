import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { ErrorArchivo, LIMITE_BYTES_ARCHIVO, leerArchivo, leerZip } from '../lib/archivos'

// Los caracteres invisibles se arman por código: escritos literales no se ven al revisar la prueba.
const LRM = String.fromCharCode(0x200e)
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])

interface EntradaZip {
  nombre: string
  contenido: string | Buffer
  /** Método 0, sin comprimir. */
  guardada?: boolean
  /** Tamaño descomprimido que se declara, para simular un zip bomb. */
  tamanoDeclarado?: number
  /** Nombre en latin1 y sin el bit 11 de UTF-8. */
  nombreLatin1?: boolean
}

/** Escritor de zip mínimo: alcanza para armar los archivos de prueba sin subir binarios al repo. */
function armarZip(entradas: EntradaZip[]): Buffer {
  const partes: Buffer[] = []
  const directorio: Buffer[] = []
  // Relleno en el encabezado local que el directorio no tiene, como hace zipalign en Android.
  const extraLocal = Buffer.from([0xfe, 0xca, 0x00, 0x00])
  let desplazamiento = 0

  for (const entrada of entradas) {
    const datos = typeof entrada.contenido === 'string' ? Buffer.from(entrada.contenido, 'utf8') : entrada.contenido
    const comprimidos = entrada.guardada ? datos : deflateRawSync(datos)
    const nombre = Buffer.from(entrada.nombre, entrada.nombreLatin1 ? 'latin1' : 'utf8')
    const bandera = entrada.nombreLatin1 ? 0 : 0x0800
    const metodo = entrada.guardada ? 0 : 8
    const crc = crc32(datos)
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

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(bandera, 8)
    central.writeUInt16LE(metodo, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comprimidos.length, 20)
    central.writeUInt32LE(tamano, 24)
    central.writeUInt16LE(nombre.length, 28)
    central.writeUInt32LE(desplazamiento, 42)
    directorio.push(central, nombre)

    desplazamiento += local.length + nombre.length + extraLocal.length + comprimidos.length
  }

  const bytesDirectorio = Buffer.concat(directorio)
  // Con comentario, para que la búsqueda del final del directorio no pueda asumir que está en los últimos 22 bytes.
  const comentario = Buffer.from('zip de prueba')
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(entradas.length, 8)
  fin.writeUInt16LE(entradas.length, 10)
  fin.writeUInt32LE(bytesDirectorio.length, 12)
  fin.writeUInt32LE(desplazamiento, 16)
  fin.writeUInt16LE(comentario.length, 20)
  return Buffer.concat([...partes, bytesDirectorio, fin, comentario])
}

const TIPOS_CONTENIDO = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

function armarDocx(cuerpo: string): Buffer {
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

function fallaCon(accion: () => unknown, mensaje: string | RegExp) {
  assert.throws(accion, (err: unknown) => {
    assert.ok(err instanceof ErrorArchivo, `se esperaba ErrorArchivo y llegó ${String(err)}`)
    assert.equal(err.name, 'ErrorArchivo')
    if (typeof mensaje === 'string') assert.equal(err.message, mensaje)
    else assert.match(err.message, mensaje)
    return true
  })
}

describe('leerArchivo con Word', () => {
  it('saca el texto por párrafo con acentos, tabs, saltos y entidades', () => {
    const docx = armarDocx(
      '<w:p w:rsidR="00A1"><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
        '<w:r><w:t>Corte de pelo</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">$8.000 </w:t></w:r>' +
        '<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/></w:rPr><w:t>&amp; lavado</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Atención de martes a sábado</w:t></w:r><w:r><w:br/>' +
        '<w:t>Turnos por WhatsApp &lt;solo mensajes&gt; &#8212; se&#xF1;a del 50%</w:t></w:r></w:p>',
    )
    const leido = leerArchivo('precios.docx', docx)
    assert.equal(leido.tipo, 'texto')
    assert.equal(leido.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(
      leido.texto,
      'Corte de pelo\t$8.000 & lavado\nAtención de martes a sábado\nTurnos por WhatsApp <solo mensajes> — seña del 50%',
    )
  })

  it('pasa las tablas a filas con tabs entre celdas', () => {
    const celda = (texto: string) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${texto}</w:t></w:r></w:p></w:tc>`
    const docx = armarDocx(
      '<w:p><w:r><w:t>Lista de precios</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr/>' +
        `<w:tr>${celda('Servicio')}${celda('Precio')}</w:tr>` +
        `<w:tr>${celda('Color')}<w:tc><w:p><w:r><w:t>$20.000</w:t></w:r></w:p><w:p><w:r><w:t>(largo)</w:t></w:r></w:p></w:tc></w:tr>` +
        '</w:tbl>' +
        '<w:p/><w:p><w:r><w:t>Precios con IVA</w:t></w:r></w:p>',
    )
    assert.equal(
      leerArchivo('lista.docx', docx).texto,
      'Lista de precios\nServicio\tPrecio\nColor\t$20.000 (largo)\n\nPrecios con IVA',
    )
  })

  it('un Word sin texto pide mandarlo como PDF', () => {
    fallaCon(() => leerArchivo('fotos.docx', armarDocx('<w:p/><w:p><w:r><w:drawing/></w:r></w:p>')), /PDF/)
  })
})

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS_HOJA = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const NS_RELACIONES = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const TIPO_HOJA = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'

describe('leerArchivo con Excel', () => {
  it('saca cada hoja en el orden del libro, con strings compartidos, inlineStr, números y celdas vacías', () => {
    const xlsx = armarZip([
      { nombre: '[Content_Types].xml', contenido: TIPOS_CONTENIDO, guardada: true },
      {
        nombre: 'xl/workbook.xml',
        contenido:
          `${XML}<workbook ${NS_HOJA} ${NS_RELACIONES}><sheets>` +
          '<sheet name="Precios" sheetId="1" r:id="rId1"/><sheet name="Horarios &amp; días" sheetId="2" r:id="rId2"/>' +
          '</sheets></workbook>',
      },
      {
        // Las rutas cruzadas a propósito: el orden sale del libro, no del nombre del archivo de la hoja.
        nombre: 'xl/_rels/workbook.xml.rels',
        contenido:
          `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId2" Type="${TIPO_HOJA}" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId1" Type="${TIPO_HOJA}" Target="/xl/worksheets/sheet2.xml"/>` +
          '<Relationship Id="rId3" Type="sharedStrings" Target="sharedStrings.xml"/></Relationships>',
      },
      {
        nombre: 'xl/sharedStrings.xml',
        contenido:
          `${XML}<sst ${NS_HOJA} count="4" uniqueCount="4">` +
          '<si><t>Producto</t></si><si><t>Precio</t></si>' +
          '<si><r><rPr><b/></rPr><t>Café</t></r><r><t xml:space="preserve"> con leche</t></r></si>' +
          '<si><t>Lunes</t></si></sst>',
      },
      {
        nombre: 'xl/worksheets/sheet1.xml',
        contenido:
          `${XML}<worksheet ${NS_HOJA}><sheetData>` +
          '<row r="2"><c r="B2" t="s"><v>3</v></c><c r="D2"><v>9</v></c><c r="E2" t="b"><v>1</v></c></row>' +
          '</sheetData></worksheet>',
      },
      {
        nombre: 'xl/worksheets/sheet2.xml',
        contenido:
          `${XML}<worksheet ${NS_HOJA}><cols><col min="1" max="3" width="20"/></cols><sheetData>` +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Nota</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500.5</v></c></row>' +
          '<row r="3"><c r="A3" s="1"/></row>' +
          '<row r="4"><c r="A4" t="inlineStr"><is><t>Medialuna</t></is></c>' +
          '<c r="C4" t="str"><f>"sin"&amp;" stock"</f><v>sin stock</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ])
    const leido = leerArchivo('precios.xlsx', xlsx)
    assert.equal(leido.tipo, 'texto')
    assert.equal(leido.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    assert.equal(
      leido.texto,
      '## Hoja: Precios\nProducto\tPrecio\tNota\nCafé con leche\t1500.5\nMedialuna\t\tsin stock\n\n' +
        '## Hoja: Horarios & días\nLunes\t\t9\tVERDADERO',
    )
  })

  it('muestra las fechas como fecha y lee libros con prefijo x: del SDK de OpenXML', () => {
    const xlsx = armarZip([
      {
        nombre: 'xl/workbook.xml',
        contenido: `${XML}<x:workbook xmlns:x="main" ${NS_RELACIONES}><x:sheets><x:sheet name="Ventas" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      },
      {
        nombre: 'xl/_rels/workbook.xml.rels',
        contenido: `${XML}<Relationships><Relationship Id="rId1" Type="${TIPO_HOJA}" Target="worksheets/hoja.xml"/></Relationships>`,
      },
      {
        // La primera lista de xf (cellStyleXfs) es una trampa: los índices de celda apuntan a cellXfs.
        nombre: 'xl/styles.xml',
        contenido:
          `${XML}<styleSheet ${NS_HOJA}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>` +
          '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
          '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"><alignment/></xf><xf numFmtId="4"/></cellXfs>' +
          '</styleSheet>',
      },
      {
        nombre: 'xl/worksheets/hoja.xml',
        contenido:
          `${XML}<x:worksheet xmlns:x="main"><x:sheetData><x:row r="1">` +
          '<x:c r="A1" s="1"><x:v>45292</x:v></x:c><x:c r="B1" s="2"><x:v>45292.5</x:v></x:c>' +
          '<x:c r="C1" s="3"><x:v>1234.5</x:v></x:c><x:c r="D1"><x:v>0.30000000000000004</x:v></x:c>' +
          '</x:row></x:sheetData></x:worksheet>',
      },
    ])
    assert.equal(leerArchivo('ventas.xlsx', xlsx).texto, '## Hoja: Ventas\n01/01/2024\t01/01/2024 12:00\t1234.5\t0.3')
  })
})

describe('leerArchivo con el .zip que exporta WhatsApp', () => {
  it('lee solo el chat, sin marcas invisibles y con saltos de línea normales', () => {
    const chat =
      '[1/3/24, 10:15:02] Sofía: Hola, ¿tienen turno mañana?\r\n' +
      `[1/3/24, 10:16:40] Peluquería Mara: ${LRM}Sí, a las 11\r\n` +
      `${LRM}[1/3/24, 10:17:05] Sofía: ${LRM}<adjunto: 00000012-AUDIO-2024-03-01.opus>\r\n`
    const audio = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 7)])
    const zip = armarZip([
      { nombre: '_chat.txt', contenido: chat },
      { nombre: '00000012-AUDIO-2024-03-01.opus', contenido: audio, guardada: true },
    ])
    assert.deepEqual(leerArchivo('WhatsApp Chat - Sofía.zip', zip), {
      tipo: 'texto',
      mime: 'application/zip',
      texto:
        '[1/3/24, 10:15:02] Sofía: Hola, ¿tienen turno mañana?\n' +
        '[1/3/24, 10:16:40] Peluquería Mara: Sí, a las 11\n' +
        '[1/3/24, 10:17:05] Sofía: <adjunto: 00000012-AUDIO-2024-03-01.opus>',
    })
  })

  it('con varios .txt los separa por nombre y saltea carpetas y copias ._ de Mac', () => {
    const zip = armarZip([
      { nombre: 'ventas/_chat.txt', contenido: 'Hola' },
      { nombre: '__MACOSX/ventas/._chat.txt', contenido: Buffer.from([0, 5, 22, 7, 0, 2]) },
      { nombre: 'ventas/fotos/', contenido: '', guardada: true },
      { nombre: 'reclamos.txt', contenido: 'Chau\n', guardada: true },
    ])
    assert.equal(leerArchivo('chats.zip', zip).texto, '### ventas/_chat.txt\nHola\n\n### reclamos.txt\nChau')
  })

  it('un .zip sin ningún .txt explica que solo se lee el chat en texto', () => {
    const zip = armarZip([
      { nombre: 'IMG-20240301-WA0001.jpg', contenido: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), guardada: true },
      { nombre: 'PTT-20240301-WA0002.opus', contenido: Buffer.from('OggS audio') },
    ])
    fallaCon(() => leerArchivo('WhatsApp Chat.zip', zip), /solo se lee el chat en texto/)
  })
})

describe('leerZip', () => {
  it('lee entradas guardadas y comprimidas, con nombres en UTF-8 y en latin1', () => {
    const largo = 'hola '.repeat(10_000)
    const entradas = leerZip(
      armarZip([
        { nombre: 'guardada.txt', contenido: 'sin comprimir', guardada: true },
        { nombre: 'comprimida.txt', contenido: largo },
        { nombre: 'año.txt', contenido: 'utf8' },
        { nombre: 'niño.txt', contenido: 'latin1', nombreLatin1: true },
        { nombre: 'vacía.txt', contenido: '' },
      ]),
    )
    assert.deepEqual([...entradas.keys()], ['guardada.txt', 'comprimida.txt', 'año.txt', 'niño.txt', 'vacía.txt'])
    assert.equal(entradas.get('guardada.txt')?.toString(), 'sin comprimir')
    assert.equal(entradas.get('comprimida.txt')?.toString(), largo)
    assert.equal(entradas.get('niño.txt')?.toString(), 'latin1')
    assert.equal(entradas.get('vacía.txt')?.length, 0)
  })

  it('frena un zip bomb: una entrada que descomprime a más de lo que declara', () => {
    const bomba = armarZip([{ nombre: '_chat.txt', contenido: Buffer.alloc(5 * 1024 * 1024), tamanoDeclarado: 100 }])
    fallaCon(() => leerZip(bomba), /dañado/)
    fallaCon(() => leerArchivo('chat.zip', bomba), /dañado/)
  })

  it('frena un .zip que declara más de 200 MB descomprimido', () => {
    const zip = armarZip([
      { nombre: 'a.txt', contenido: 'hola', tamanoDeclarado: 150 * 1024 * 1024 },
      { nombre: 'b.txt', contenido: 'chau', tamanoDeclarado: 60 * 1024 * 1024 },
    ])
    fallaCon(() => leerZip(zip), /200 MB/)
  })

  it('un zip roto pide volver a exportarlo, y un Word roto habla de Word', () => {
    fallaCon(
      () => leerZip(Buffer.from('PK\x03\x04 esto no es un zip de verdad')),
      'El archivo .zip está dañado. Volvé a exportarlo y subilo de nuevo.',
    )
    const entero = armarZip([{ nombre: '_chat.txt', contenido: 'Hola' }])
    fallaCon(() => leerArchivo('chat.zip', entero.subarray(0, entero.length - 40)), /\.zip está dañado/)
    fallaCon(() => leerArchivo('lista.docx', entero.subarray(0, 20)), /Word está dañado/)
  })
})

describe('leerArchivo detecta imágenes y PDF por sus bytes', () => {
  const casos: [string, Buffer, 'imagen' | 'pdf', string][] = [
    ['foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'imagen', 'image/png'],
    // El navegador dice text/plain y el nombre miente: manda la firma.
    ['captura.txt', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]), 'imagen', 'image/jpeg'],
    ['animacion', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), 'imagen', 'image/gif'],
    ['sticker.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), 'imagen', 'image/webp'],
    ['lista.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n'), 'pdf', 'application/pdf'],
    ['escaneo.pdf', Buffer.from('\r\n%PDF-1.4\n'), 'pdf', 'application/pdf'],
  ]
  for (const [nombre, datos, tipo, mime] of casos) {
    it(`${nombre}: ${mime}`, () => {
      assert.deepEqual(leerArchivo(nombre, datos), { tipo, mime, texto: null })
    })
  }
})

describe('leerArchivo rechaza lo que no puede leer', () => {
  it('fotos HEIC del iPhone, por firma o por extensión', () => {
    const mensaje = 'Las fotos HEIC del iPhone no se pueden leer. Mandá una captura de pantalla o exportala como JPG.'
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic')])
    fallaCon(() => leerArchivo('IMG_4412.jpg', heic), mensaje)
    fallaCon(() => leerArchivo('IMG_4413.HEIC', Buffer.from('cualquier cosa')), mensaje)
  })

  it('audios y videos, por firma o por extensión', () => {
    const mensaje = 'No se aceptan audios ni videos. Escribí o pegá el texto.'
    fallaCon(() => leerArchivo('nota.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0x21])])), mensaje)
    fallaCon(() => leerArchivo('sin-etiqueta', Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])), mensaje)
    fallaCon(() => leerArchivo('PTT-WA0001.txt', Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2])), mensaje)
    fallaCon(() => leerArchivo('video.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')])), mensaje)
    fallaCon(() => leerArchivo('audio.m4a', Buffer.from('bytes que no coinciden con ninguna firma')), mensaje)
  })

  it('Word y Excel viejos piden guardarlos como .docx o .xlsx', () => {
    fallaCon(() => leerArchivo('precios.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /\.docx o \.xlsx/)
  })

  it('un formato desconocido lista los que sí se aceptan', () => {
    fallaCon(
      () => leerArchivo('logo.bmp', Buffer.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0])),
      /imágenes \(JPG, PNG, WEBP, GIF\), PDF, Word \(\.docx\), Excel \(\.xlsx\), texto \(\.txt, \.csv, \.md\) y el \.zip que exporta WhatsApp/,
    )
  })

  it('una extensión que no coincide con lo que hay adentro', () => {
    fallaCon(() => leerArchivo('foto.jpg', Buffer.from('esto es texto, no una foto')), /dice ser \.jpg/)
  })
})

describe('leerArchivo con texto', () => {
  it('UTF-8 con BOM: saca el BOM y normaliza los saltos de línea', () => {
    const datos = Buffer.concat([BOM_UTF8, Buffer.from('Servicio;Seña\r\nCorte;$8.000\r\n')])
    assert.deepEqual(leerArchivo('precios.csv', datos), { tipo: 'texto', mime: 'text/csv', texto: 'Servicio;Seña\nCorte;$8.000' })
  })

  it('windows-1252: la ñ y el € no se rompen', () => {
    const datos = Buffer.concat([
      Buffer.from('Precio del pa'),
      Buffer.from([0xf1]),
      Buffer.from('uelo: '),
      Buffer.from([0x80]),
      Buffer.from(' 12'),
    ])
    assert.deepEqual(leerArchivo('lista.txt', datos), { tipo: 'texto', mime: 'text/plain', texto: 'Precio del pañuelo: € 12' })
  })

  it('UTF-16 con BOM, como exporta Excel el texto Unicode', () => {
    const datos = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café\t1500\r\n', 'utf16le')])
    assert.equal(leerArchivo('precios.txt', datos).texto, 'Café\t1500')
    assert.equal(leerArchivo('precios', datos).texto, 'Café\t1500')
  })

  it('sin extensión conocida y sin bytes nulos, se lee como texto', () => {
    assert.deepEqual(leerArchivo('notas.log', Buffer.from('Horario: 9 a 18')), {
      tipo: 'texto',
      mime: 'text/plain',
      texto: 'Horario: 9 a 18',
    })
  })

  it('recorta los textos enormes y lo avisa al final', () => {
    const texto = leerArchivo('chat.txt', Buffer.from('a'.repeat(300_123))).texto ?? ''
    assert.ok(texto.startsWith(`${'a'.repeat(300_000)}\n\n[`))
    assert.match(texto, /\n\[Se recortó el texto: tenía 300\.123 caracteres y se dejaron los primeros 300\.000\.\]$/)
  })
})

describe('leerArchivo con archivos vacíos o pesados', () => {
  it('vacío', () => {
    fallaCon(() => leerArchivo('chat.txt', Buffer.alloc(0)), /está vacío/)
    fallaCon(() => leerArchivo('chat.txt', Buffer.from(' \r\n\t ')), /está vacío/)
  })

  it('más de 20 MB', () => {
    fallaCon(() => leerArchivo('lista.pdf', Buffer.alloc(LIMITE_BYTES_ARCHIVO + 1)), /pesa más de 20 MB/)
  })

  it('justo 20 MB se acepta', () => {
    const datos = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(LIMITE_BYTES_ARCHIVO - 9)])
    assert.equal(leerArchivo('lista.pdf', datos).tipo, 'pdf')
  })
})
