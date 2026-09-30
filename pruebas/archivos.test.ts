import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ErrorArchivo,
  expandirZip,
  firmaDe,
  formatoFfmpeg,
  hashDeArchivo,
  ladosDeImagen,
  leerArchivo,
  leerArchivoDeDisco,
  leerZip,
  LIMITE_BYTES_ARCHIVO,
  PROBLEMA_FORMATO,
  tipoDeZip,
} from '../lib/archivos'
import * as textos from '../lib/motor/textos'
import { armarDocx, armarZip, AUDIO_OGG, JPEG, PDF, TIPOS_CONTENIDO, VIDEO_MP4, type EntradaZip, type OpcionesZip } from './zip-de-prueba'

// Los caracteres invisibles se arman por código: escritos literales no se ven al revisar la prueba.
const LRM = String.fromCharCode(0x200e)
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])

const CARPETA = mkdtempSync(join(tmpdir(), 'cuestionario-archivos-'))

/** Una carpeta nueva y vacía dentro de la de las pruebas. */
function carpetaNueva(): string {
  return mkdtempSync(join(CARPETA, 'caso-'))
}

function enDisco(nombre: string, datos: Buffer): string {
  const ruta = join(carpetaNueva(), nombre)
  writeFileSync(ruta, datos)
  return ruta
}

function zipEnDisco(entradas: EntradaZip[], opciones: OpcionesZip = {}): string {
  return enDisco('subido.zip', armarZip(entradas, opciones))
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

const rechazaCon = (mensaje: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ErrorArchivo, `se esperaba ErrorArchivo y llegó ${String(err)}`)
  assert.match(err.message, mensaje)
  return true
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

  it('un Word sin texto queda guardado, con la nota de mandarlo como PDF', () => {
    const leido = leerArchivo('fotos.docx', armarDocx('<w:p/><w:p><w:r><w:drawing/></w:r></w:p>'))
    assert.equal(leido.tipo, 'otro')
    assert.equal(leido.texto, '')
    assert.match(leido.problema ?? '', /PDF/)
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
  })

  it('frena un .zip que declara más de 200 MB descomprimido', () => {
    const zip = armarZip([
      { nombre: 'a.txt', contenido: 'hola', tamanoDeclarado: 150 * 1024 * 1024 },
      { nombre: 'b.txt', contenido: 'chau', tamanoDeclarado: 60 * 1024 * 1024 },
    ])
    fallaCon(() => leerZip(zip), /200 MB/)
  })

  it('un zip roto pide volver a exportarlo', () => {
    fallaCon(
      () => leerZip(Buffer.from('PK\x03\x04 esto no es un zip de verdad')),
      'El archivo .zip está dañado. Volvé a exportarlo y subilo de nuevo.',
    )
  })

  it('lee el formato ZIP64, que algunas herramientas usan aunque el archivo sea chico', () => {
    const entradas = leerZip(armarZip([{ nombre: 'a.txt', contenido: 'uno' }, { nombre: 'carpeta/b.txt', contenido: 'dos', guardada: true }], { zip64: true }))
    assert.equal(entradas.get('a.txt')?.toString(), 'uno')
    assert.equal(entradas.get('carpeta/b.txt')?.toString(), 'dos')
  })
})

describe('expandirZip', () => {
  const CHAT =
    '[1/3/24, 10:15:02] Sofía: Hola, ¿tienen turno mañana?\r\n' +
    `[1/3/24, 10:16:40] Peluquería Mara: ${LRM}Sí, a las 11\r\n` +
    `${LRM}[1/3/24, 10:17:05] Sofía: ${LRM}<adjunto: 00000012-AUDIO-2024-03-01.opus>\r\n`
  const sinLimite = { presupuestoBytes: 500 * 1024 * 1024 }

  it('del .zip plano de WhatsApp saca el chat y cada adjunto como archivo propio', async () => {
    const destino = carpetaNueva()
    const zip = zipEnDisco([
      { nombre: '_chat.txt', contenido: CHAT },
      { nombre: '00000012-AUDIO-2024-03-01.opus', contenido: AUDIO_OGG, guardada: true },
      { nombre: '00000013-PHOTO-2024-03-01.jpg', contenido: JPEG, guardada: true },
    ])
    const { archivos, omitidos } = await expandirZip(zip, destino, sinLimite)
    assert.deepEqual(omitidos, [])
    assert.deepEqual(
      archivos.map((a) => [a.rutaEnZip, a.bytes]),
      [
        ['_chat.txt', Buffer.byteLength(CHAT)],
        ['00000012-AUDIO-2024-03-01.opus', AUDIO_OGG.length],
        ['00000013-PHOTO-2024-03-01.jpg', JPEG.length],
      ],
    )
    assert.deepEqual(readFileSync(archivos[0].ruta, 'utf8'), CHAT)
    assert.deepEqual(readFileSync(archivos[1].ruta), AUDIO_OGG)

    // Lo que antes se ignoraba ahora se lee: el audio es un audio y el chat es texto sin marcas invisibles.
    const audio = await leerArchivoDeDisco('00000012-AUDIO-2024-03-01.opus', archivos[1].ruta)
    assert.deepEqual(audio, { tipo: 'audio', mime: 'audio/ogg', texto: null, problema: null })
    const chat = await leerArchivoDeDisco('_chat.txt', archivos[0].ruta)
    assert.equal(
      chat.texto,
      '[1/3/24, 10:15:02] Sofía: Hola, ¿tienen turno mañana?\n' +
        '[1/3/24, 10:16:40] Peluquería Mara: Sí, a las 11\n' +
        '[1/3/24, 10:17:05] Sofía: <adjunto: 00000012-AUDIO-2024-03-01.opus>',
    )
  })

  it('conserva las carpetas de adentro como ruta y saltea carpetas, vacíos, enlaces y lo que deja Mac', async () => {
    const zip = zipEnDisco([
      { nombre: 'ventas/_chat.txt', contenido: 'Hola' },
      { nombre: '__MACOSX/ventas/._chat.txt', contenido: Buffer.from([0, 5, 22, 7, 0, 2]) },
      { nombre: 'ventas/._foto.jpg', contenido: Buffer.from([0, 5, 22, 7]) },
      { nombre: 'ventas/.DS_Store', contenido: 'basura' },
      { nombre: 'ventas/fotos/', contenido: '', guardada: true },
      { nombre: 'ventas/vacio.txt', contenido: '' },
      { nombre: 'ventas/enlace', contenido: '/etc/passwd', guardada: true, enlace: true },
      { nombre: 'ventas\\Audios y videos\\a.opus', contenido: AUDIO_OGG },
      { nombre: 'niño.txt', contenido: 'latin1', nombreLatin1: true },
    ])
    const { archivos, omitidos } = await expandirZip(zip, carpetaNueva(), sinLimite)
    assert.deepEqual(omitidos, [])
    assert.deepEqual(
      archivos.map((a) => a.rutaEnZip),
      ['ventas/_chat.txt', 'ventas/Audios y videos/a.opus', 'niño.txt'],
    )
  })

  it('las rutas de adentro nunca llegan al disco: ../ y las rutas absolutas no salen de la carpeta', async () => {
    const zip = zipEnDisco([
      { nombre: '../fuera.txt', contenido: 'uno' },
      { nombre: '../../../../tmp/mas-afuera.txt', contenido: 'dos' },
      { nombre: '/abs/dentro.txt', contenido: 'tres' },
      { nombre: 'C:\\Windows\\x.txt', contenido: 'cuatro' },
    ])
    const destino = carpetaNueva()
    const antes = readdirSync(CARPETA).sort()
    const { archivos } = await expandirZip(zip, destino, sinLimite)
    assert.equal(archivos.length, 4)
    for (const archivo of archivos) {
      assert.match(archivo.id, /^[0-9a-f-]{36}$/)
      assert.equal(archivo.ruta, join(destino, archivo.id))
    }
    assert.deepEqual(readdirSync(destino).sort(), archivos.map((a) => a.id).sort())
    assert.deepEqual(readdirSync(CARPETA).sort(), antes)
    assert.equal(existsSync(join(destino, '..', 'fuera.txt')), false)
    assert.equal(existsSync('/abs/dentro.txt'), false)
  })

  it('lo que no se puede sacar queda en omitidos y el resto sale igual', async () => {
    const destino = carpetaNueva()
    const zip = zipEnDisco([
      { nombre: 'bueno.txt', contenido: 'esto sí' },
      // Declara 100 bytes y descomprime a 5 MB: un zip bomb.
      { nombre: 'bomba.txt', contenido: Buffer.alloc(5 * 1024 * 1024), tamanoDeclarado: 100 },
      { nombre: 'cortado.txt', contenido: 'corto', tamanoDeclarado: 5000 },
      { nombre: 'crc.txt', contenido: 'el contenido no coincide con su suma', crcMalo: true },
      { nombre: 'guardado-mal.txt', contenido: 'abc', guardada: true, tamanoDeclarado: 50 },
      { nombre: 'con-clave.pdf', contenido: PDF, cifrada: true },
      { nombre: 'bzip2.txt', contenido: 'otro método', metodo: 12 },
    ])
    const { archivos, omitidos } = await expandirZip(zip, destino, sinLimite)
    assert.deepEqual(
      archivos.map((a) => a.rutaEnZip),
      ['bueno.txt'],
    )
    assert.deepEqual(omitidos, [
      { nombre: 'bomba.txt', motivo: 'dañado' },
      { nombre: 'cortado.txt', motivo: 'dañado' },
      { nombre: 'crc.txt', motivo: 'dañado' },
      { nombre: 'guardado-mal.txt', motivo: 'dañado' },
      { nombre: 'con-clave.pdf', motivo: 'cifrado' },
      { nombre: 'bzip2.txt', motivo: 'formato de compresión que no leemos' },
    ])
    // De lo que falló no queda nada a medias en el disco.
    assert.deepEqual(readdirSync(destino), [archivos[0].id])
  })

  it('no abre un .zip que declara más de lo que queda de espacio', async () => {
    const zip = zipEnDisco([
      { nombre: 'a.txt', contenido: 'hola', tamanoDeclarado: 150 * 1024 * 1024 },
      { nombre: 'b.txt', contenido: 'chau', tamanoDeclarado: 60 * 1024 * 1024 },
    ])
    const destino = carpetaNueva()
    await assert.rejects(
      expandirZip(zip, destino, { presupuestoBytes: 200 * 1024 * 1024 }),
      rechazaCon(/pasa el espacio que queda \(200 MB\)\. Subí las conversaciones de a una\./),
    )
    assert.deepEqual(readdirSync(destino), [])
  })

  it('no abre un .zip con más de 1000 archivos', async () => {
    const muchas = Array.from({ length: 1001 }, (_, i) => ({ nombre: `f${i}.txt`, contenido: 'x', guardada: true }))
    await assert.rejects(expandirZip(zipEnDisco(muchas), carpetaNueva(), sinLimite), rechazaCon(/demasiados archivos/))
    const { archivos } = await expandirZip(zipEnDisco(muchas.slice(0, 5)), carpetaNueva(), { ...sinLimite, maximoEntradas: 5 })
    assert.equal(archivos.length, 5)
  })

  it('un .zip roto o cortado pide volver a exportarlo', async () => {
    const entero = armarZip([{ nombre: '_chat.txt', contenido: 'Hola' }])
    for (const roto of [Buffer.from('PK\x03\x04 esto no es un zip de verdad'), entero.subarray(0, entero.length - 40)]) {
      await assert.rejects(expandirZip(enDisco('roto.zip', roto), carpetaNueva(), sinLimite), rechazaCon(/\.zip está dañado/))
    }
  })

  it('abre un .zip en formato ZIP64', async () => {
    const zip = zipEnDisco([{ nombre: '_chat.txt', contenido: CHAT }, { nombre: 'a.jpg', contenido: JPEG, guardada: true }], { zip64: true })
    const { archivos, omitidos } = await expandirZip(zip, carpetaNueva(), sinLimite)
    assert.deepEqual(omitidos, [])
    assert.deepEqual(readFileSync(archivos[0].ruta, 'utf8'), CHAT)
    assert.deepEqual(readFileSync(archivos[1].ruta), JPEG)
  })

  it('un .zip de adentro sale como un archivo más, que por sí solo no se abre', async () => {
    const interno = armarZip([{ nombre: '_chat.txt', contenido: CHAT }])
    const { archivos } = await expandirZip(zipEnDisco([{ nombre: 'WhatsApp Chat - Sofía.zip', contenido: interno, guardada: true }]), carpetaNueva(), sinLimite)
    assert.equal(await tipoDeZip(archivos[0].ruta), 'contenedor')
    assert.deepEqual(await leerArchivoDeDisco('WhatsApp Chat - Sofía.zip', archivos[0].ruta), {
      tipo: 'otro',
      mime: 'application/zip',
      texto: '',
      problema: 'Un .zip adentro de otro no se abre: subilo aparte.',
    })
  })
})

describe('tipoDeZip', () => {
  const clase = (entradas: EntradaZip[]) => tipoDeZip(zipEnDisco(entradas))

  it('distingue Word y Excel de un .zip que se abre', async () => {
    assert.equal(await tipoDeZip(enDisco('lista.docx', armarDocx('<w:p><w:r><w:t>Hola</w:t></w:r></w:p>'))), 'docx')
    assert.equal(await clase([{ nombre: 'xl/workbook.xml', contenido: '<workbook/>' }]), 'xlsx')
    assert.equal(await clase([{ nombre: '_chat.txt', contenido: 'Hola' }, { nombre: 'a.jpg', contenido: JPEG }]), 'contenedor')
  })

  it('un PowerPoint, un OpenDocument o un Pages no son una carpeta de archivos: no se abren', async () => {
    const pptx = [
      { nombre: '[Content_Types].xml', contenido: TIPOS_CONTENIDO },
      { nombre: 'ppt/presentation.xml', contenido: '<p:presentation/>' },
      { nombre: 'ppt/media/image1.jpg', contenido: JPEG },
    ]
    assert.equal(await clase(pptx), 'documento')
    assert.equal(await clase([{ nombre: 'mimetype', contenido: 'application/vnd.oasis.opendocument.text', guardada: true }, { nombre: 'content.xml', contenido: '<x/>' }]), 'documento')
    assert.equal(await clase([{ nombre: 'Index/Document.iwa', contenido: 'x' }, { nombre: 'Data/foto.jpg', contenido: JPEG }]), 'documento')

    assert.deepEqual(leerArchivo('catalogo.pptx', armarZip(pptx)), { tipo: 'otro', mime: 'application/zip', texto: '', problema: PROBLEMA_FORMATO })
  })

  it('un .zip dañado avisa en vez de clasificarse', async () => {
    await assert.rejects(tipoDeZip(enDisco('roto.zip', Buffer.from('PK\x03\x04 nada'))), rechazaCon(/\.zip está dañado/))
  })
})

describe('leerArchivo reconoce cada tipo por sus bytes', () => {
  const ftyp = (marca: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${marca}`), Buffer.alloc(12)])
  const bmp = Buffer.alloc(30)
  bmp.write('BM', 0, 'latin1')
  bmp.writeUInt32LE(40, 14)

  // [nombre, bytes, tipo, mime, lector de ffmpeg]
  const casos: [string, Buffer, string, string, string | null][] = [
    ['foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'imagen', 'image/png', 'png_pipe'],
    // El navegador dice text/plain y el nombre miente: manda la firma.
    ['captura.txt', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]), 'imagen', 'image/jpeg', 'jpeg_pipe'],
    ['animacion', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), 'imagen', 'image/gif', 'gif'],
    ['sticker.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), 'imagen', 'image/webp', 'webp_pipe'],
    ['lista.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n'), 'pdf', 'application/pdf', null],
    ['escaneo.pdf', Buffer.from('\r\n%PDF-1.4\n'), 'pdf', 'application/pdf', null],
    // La foto del iPhone ya no se rechaza: se convierte al leerla.
    ['IMG_4412.jpg', ftyp('heic'), 'imagen', 'image/heic', 'mov'],
    ['foto.avif', ftyp('avif'), 'imagen', 'image/avif', 'mov'],
    ['logo.bmp', bmp, 'imagen', 'image/bmp', 'bmp_pipe'],
    ['plano.tif', Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), 'imagen', 'image/tiff', 'tiff_pipe'],
    ['nota.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0x21])]), 'audio', 'audio/mpeg', 'mp3'],
    ['sin-etiqueta', Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0]), 'audio', 'audio/mpeg', 'mp3'],
    ['voz.aac', Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0]), 'audio', 'audio/aac', 'aac'],
    ['PTT-WA0001.txt', Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2]), 'audio', 'audio/ogg', 'ogg'],
    ['nota.m4a', ftyp('M4A '), 'audio', 'audio/mp4', 'mov'],
    ['voz.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]), 'audio', 'audio/wav', 'wav'],
    ['voz.flac', Buffer.from('fLaC\x00\x00\x00\x22'), 'audio', 'audio/flac', 'flac'],
    ['voz.amr', Buffer.from('#!AMR\n\x3c\x91'), 'audio', 'audio/amr', 'amr'],
    ['video.mp4', ftyp('isom'), 'video', 'video/mp4', 'mov'],
    ['video.mov', ftyp('qt  '), 'video', 'video/quicktime', 'mov'],
    ['viejo.mov', Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('wide'), Buffer.from([0, 0, 0x10, 0]), Buffer.from('mdat')]), 'video', 'video/quicktime', 'mov'],
    ['video.3gp', ftyp('3gp4'), 'video', 'video/3gpp', 'mov'],
    ['video.avi', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]), 'video', 'video/x-msvideo', 'avi'],
    ['video.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), 'video', 'video/webm', 'matroska'],
  ]
  for (const [nombre, datos, tipo, mime, formato] of casos) {
    it(`${nombre}: ${mime}`, () => {
      assert.deepEqual(leerArchivo(nombre, datos), { tipo, mime, texto: null, problema: null })
      assert.equal(formatoFfmpeg(datos), formato)
    })
  }

  it('un texto que empieza parecido a un video no se confunde', () => {
    // «The free…» tiene «free» donde un QuickTime viejo tiene el nombre del átomo.
    assert.equal(leerArchivo('nota.txt', Buffer.from('The free shipping ends on Friday')).tipo, 'texto')
    assert.equal(firmaDe(Buffer.from('BM de la semana: 3 fundas vendidas')), null)
  })
})

describe('leerArchivo guarda con su nota lo que no puede leer, sin frenar la subida', () => {
  const otro = (nombre: string, datos: Buffer) => {
    const leido = leerArchivo(nombre, datos)
    assert.equal(leido.tipo, 'otro', nombre)
    assert.equal(leido.texto, '', nombre)
    return leido.problema ?? ''
  }

  it('lo que solo por el nombre parece audio, video o foto no llega a ffmpeg', () => {
    // Una lista de reproducción renombrada a .mp4 haría que ffmpeg pidiera direcciones de la red interna.
    const lista = Buffer.from('#EXTM3U\n#EXTINF:10,\nhttp://127.0.0.1:8080/interno\n')
    assert.equal(otro('video.mp4', lista), PROBLEMA_FORMATO)
    assert.equal(formatoFfmpeg(lista), null)
    assert.equal(otro('audio.m4a', Buffer.from('bytes que no coinciden con ninguna firma')), PROBLEMA_FORMATO)
    assert.equal(otro('IMG_4413.HEIC', Buffer.from('cualquier cosa')), PROBLEMA_FORMATO)
    assert.equal(otro('lista.ffconcat', Buffer.concat([Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n'), Buffer.alloc(4)])), PROBLEMA_FORMATO)
  })

  it('el texto del problema es el mismo que usa el motor', () => {
    assert.equal(PROBLEMA_FORMATO, textos.PROBLEMA_FORMATO)
  })

  it('Word y Excel viejos piden guardarlos como .docx o .xlsx', () => {
    assert.match(otro('precios.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /\.docx o \.xlsx/)
    assert.match(otro('guion.doc', Buffer.from('{\\rtf1 esto es un rtf}')), /\.docx o \.xlsx/)
  })

  it('un binario desconocido', () => {
    assert.equal(otro('programa.exe', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])), PROBLEMA_FORMATO)
  })

  it('una extensión que no coincide con lo que hay adentro', () => {
    assert.match(otro('foto.jpg', Buffer.from('esto es texto, no una foto')), /dice ser \.jpg/)
    assert.match(otro('chat.txt', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff])), /dice ser \.txt/)
  })

  it('un Word o un .zip roto dice cuál de los dos está dañado', () => {
    const entero = armarZip([{ nombre: '_chat.txt', contenido: 'Hola' }])
    assert.match(otro('chat.zip', entero.subarray(0, entero.length - 40)), /\.zip está dañado/)
    assert.match(otro('lista.docx', entero.subarray(0, 20)), /Word está dañado/)
  })

  it('un .zip común, que no se abre acá, avisa que hay que subirlo aparte', () => {
    assert.match(otro('chats.zip', armarZip([{ nombre: '_chat.txt', contenido: 'Hola' }])), /subilo aparte/)
  })
})

describe('leerArchivo con texto', () => {
  it('UTF-8 con BOM: saca el BOM y normaliza los saltos de línea', () => {
    const datos = Buffer.concat([BOM_UTF8, Buffer.from('Servicio;Seña\r\nCorte;$8.000\r\n')])
    assert.deepEqual(leerArchivo('precios.csv', datos), { tipo: 'texto', mime: 'text/csv', texto: 'Servicio;Seña\nCorte;$8.000', problema: null })
  })

  it('windows-1252: la ñ y el € no se rompen', () => {
    const datos = Buffer.concat([
      Buffer.from('Precio del pa'),
      Buffer.from([0xf1]),
      Buffer.from('uelo: '),
      Buffer.from([0x80]),
      Buffer.from(' 12'),
    ])
    assert.deepEqual(leerArchivo('lista.txt', datos), { tipo: 'texto', mime: 'text/plain', texto: 'Precio del pañuelo: € 12', problema: null })
  })

  it('UTF-16 con BOM, como exporta Excel el texto Unicode', () => {
    const datos = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Café\t1500\r\n', 'utf16le')])
    assert.equal(leerArchivo('precios.txt', datos).texto, 'Café\t1500')
    assert.equal(leerArchivo('precios', datos).texto, 'Café\t1500')
  })

  it('sin extensión conocida y sin bytes nulos, se lee como texto: un contacto de WhatsApp, por ejemplo', () => {
    assert.deepEqual(leerArchivo('Proveedor.vcf', Buffer.from('BEGIN:VCARD\nFN:Proveedor de cueros\nEND:VCARD')), {
      tipo: 'texto',
      mime: 'text/plain',
      texto: 'BEGIN:VCARD\nFN:Proveedor de cueros\nEND:VCARD',
      problema: null,
    })
  })

  it('recorta los textos enormes y lo avisa al final', () => {
    const texto = leerArchivo('chat.txt', Buffer.from('a'.repeat(300_123))).texto ?? ''
    assert.ok(texto.startsWith(`${'a'.repeat(300_000)}\n\n[`))
    assert.match(texto, /\n\[Se recortó el texto: tenía 300\.123 caracteres y se dejaron los primeros 300\.000\.\]$/)
  })

  it('un texto en blanco queda con su nota en vez de frenar la subida del .zip que lo trae', () => {
    const leido = leerArchivo('chat.txt', Buffer.from(' \r\n\t '))
    assert.equal(leido.texto, '')
    assert.match(leido.problema ?? '', /está vacío/)
  })
})

describe('lo único que frena una subida: archivos vacíos o demasiado pesados', () => {
  it('vacío', async () => {
    fallaCon(() => leerArchivo('chat.txt', Buffer.alloc(0)), /está vacío/)
    await assert.rejects(leerArchivoDeDisco('chat.txt', enDisco('chat.txt', Buffer.alloc(0))), rechazaCon(/está vacío/))
  })

  it('más de 200 MB no, justo 200 MB sí', () => {
    const datos = Buffer.alloc(LIMITE_BYTES_ARCHIVO + 1)
    datos.write('%PDF-1.7\n', 0, 'latin1')
    fallaCon(() => leerArchivo('lista.pdf', datos), /pesa más de 200 MB/)
    assert.equal(leerArchivo('lista.pdf', datos.subarray(0, LIMITE_BYTES_ARCHIVO)).tipo, 'pdf')
  })
})

describe('leerArchivoDeDisco no carga en memoria lo que no hace falta', () => {
  it('un video grande se reconoce por su cabecera', async () => {
    const ruta = enDisco('video.mp4', Buffer.concat([VIDEO_MP4, Buffer.alloc(2 * 1024 * 1024)]))
    assert.deepEqual(await leerArchivoDeDisco('video.mp4', ruta), { tipo: 'video', mime: 'video/mp4', texto: null, problema: null })
  })

  it('un chat largo se lee entero', async () => {
    const chat = '[1/3/24, 10:15:02] Sofía: Hola, ¿tienen turno mañana?\n'.repeat(12_000).trim()
    const leido = await leerArchivoDeDisco('_chat.txt', enDisco('_chat.txt', Buffer.from(chat)))
    assert.equal(leido.tipo, 'texto')
    assert.equal(leido.texto, chat.slice(0, 300_000) + leido.texto!.slice(300_000))
    assert.match(leido.texto ?? '', /Se recortó el texto/)
  })

  it('un Word se lee igual que en memoria', async () => {
    const docx = armarDocx('<w:p><w:r><w:t>Corte de pelo $8.000</w:t></w:r></w:p>')
    assert.equal((await leerArchivoDeDisco('precios.docx', enDisco('precios.docx', docx))).texto, 'Corte de pelo $8.000')
  })

  it('un texto de más de 20 MB queda guardado con la nota de subir solo la parte que importa', async () => {
    const ruta = enDisco('registro.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 'a'))
    const leido = await leerArchivoDeDisco('registro.txt', ruta)
    assert.equal(leido.tipo, 'otro')
    assert.match(leido.problema ?? '', /demasiado grande para leerlo como texto/)
  })

  it('hashDeArchivo da el sha256 de los bytes', async () => {
    const datos = Buffer.from('los mismos bytes dan el mismo hash')
    assert.equal(await hashDeArchivo(enDisco('a.txt', datos)), createHash('sha256').update(datos).digest('hex'))
  })
})

describe('ladosDeImagen', () => {
  // Solo los encabezados: alcanzan para leer el tamaño sin armar una imagen entera.
  function png(ancho: number, alto: number): Buffer {
    const datos = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(datos)
    datos.write('IHDR', 12, 'latin1')
    datos.writeUInt32BE(ancho, 16)
    datos.writeUInt32BE(alto, 20)
    return datos
  }

  function jpeg(ancho: number, alto: number): Buffer {
    const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
    const sof = Buffer.from([0xff, 0xc2, 0, 11, 8, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 1, 1, 0x11, 0])
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
  }

  function webp(ancho: number, alto: number): Buffer {
    const datos = Buffer.alloc(30)
    datos.write('RIFF', 0, 'latin1')
    datos.write('WEBPVP8X', 8, 'latin1')
    datos.writeUIntLE(ancho - 1, 24, 3)
    datos.writeUIntLE(alto - 1, 27, 3)
    return datos
  }

  it('lee el tamaño de PNG, JPEG, WEBP y GIF', () => {
    assert.deepEqual(ladosDeImagen(png(1170, 9000), 'image/png'), [1170, 9000])
    assert.deepEqual(ladosDeImagen(jpeg(8064, 6048), 'image/jpeg'), [8064, 6048])
    assert.deepEqual(ladosDeImagen(webp(9000, 100), 'image/webp'), [9000, 100])
    assert.deepEqual(ladosDeImagen(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x92, 0x04, 0x28, 0x23]), 'image/gif'), [1170, 9000])
  })

  it('devuelve null si no se puede leer, en vez de tirar', () => {
    assert.equal(ladosDeImagen(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), null)
    assert.equal(ladosDeImagen(Buffer.from('cualquier cosa'), 'image/heic'), null)
  })

  it('una imagen pesada o gigante ya no se rechaza al subirla: se achica al leerla', () => {
    assert.equal(leerArchivo('larga.png', png(1170, 9000)).tipo, 'imagen')
    const pesada = Buffer.concat([png(1290, 2796), Buffer.alloc(8 * 1024 * 1024)])
    assert.deepEqual(leerArchivo('captura.png', pesada), { tipo: 'imagen', mime: 'image/png', texto: null, problema: null })
  })
})
