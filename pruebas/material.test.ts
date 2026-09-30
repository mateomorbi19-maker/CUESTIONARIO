import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  armarTextoDelMaterial,
  contextoDeAdjunto,
  conversaciones,
  esAdjuntoDeConversacion,
  esChat,
  grupoEfectivo,
  LIMITE_CARACTERES_MATERIAL,
  recorteDelMaterial,
  resumenDeMaterial,
  soloLiteral,
  textoDeArchivos,
  tieneMarcadorDeLaApp,
} from '../lib/motor/material'
import { estadoInicial } from '../lib/motor/motor'
import { armarReporteCierre } from '../lib/motor/reporte'
import type { ArchivoMaterial, EstadoCuestionario } from '../lib/motor/tipos'

/*
 * El texto que lee Claude. Todo inventado: los chats imitan el formato que exporta WhatsApp, con
 * nombres de un negocio que no existe.
 */

const ESPACIO_DURO = String.fromCharCode(0x00a0)
const GUION_DURO = String.fromCharCode(0x2011)

let siguiente = 0
function archivo(nombre: string, tipo: ArchivoMaterial['tipo'], texto: string | null, mas: Partial<ArchivoMaterial> = {}): ArchivoMaterial {
  siguiente++
  return { id: `a${siguiente}`, nombre, mime: 'x/x', tipo, bytes: 10, texto, etapa: 'material', hash: `hash-${siguiente}`, ...mas }
}

const CHAT_LAURA = `[16/9/26, 10:05:44 a. m.] Laura: Hola! Precio de fundas para Gol Trend?
[16/9/26, 10:06:10 a. m.] Tapicería Norte: <adjunto: 00000043-AUDIO-2026-09-16-10-06-10.opus>
[16/9/26, 11:14:26 a. m.] Tapicería Norte: Así quedan con el vivo rojo <adjunto: 00000056-PHOTO-2026-09-16-11-14-26.jpg>
[16/9/26, 11:20:02 a. m.] Laura: Comprobante.pdf • 1 página <adjunto: 00000070-Comprobante.pdf>
[16/9/26, 12:09:30 p. m.] Tapicería Norte: Y así el cubrevolante <adjunto: 00000084-VIDEO-2026-09-16-12-09-30.mp4>
[16/9/26, 12:15:00 p. m.] Laura: <adjunto: 00000091-PHOTO-2026-09-16-12-15-00.jpg>`

const CHAT_PABLO = `25/9/26, 2:41 p. m. - Pablo: cuanto sale para un Cronos?
25/9/26, 2:43 p. m. - Tapicería Norte: PTT-20260925-WA0003.opus (archivo adjunto)
25/9/26, 2:50 p. m. - Tapicería Norte: IMG-20260925-WA0004.jpg (archivo adjunto)
Mirá cómo queda`

function conversacionDeLaura(): ArchivoMaterial[] {
  const grupo = '1 - Venta cerrada - Laura'
  return [
    archivo('_chat.txt', 'texto', CHAT_LAURA, { grupo }),
    archivo('00000043-AUDIO-2026-09-16-10-06-10.opus', 'audio', 'Hola Laura, las de cuero ecológico salen 80 mil de lista.', { grupo, duracion: 13 }),
    archivo('00000056-PHOTO-2026-09-16-11-14-26.jpg', 'imagen', '', { grupo, descripcion: 'Asiento delantero con funda negra y costura roja.' }),
    archivo('00000070-Comprobante.pdf', 'pdf', 'Transferencia a Tapicería Norte por $72.000', { grupo }),
    archivo('00000084-VIDEO-2026-09-16-12-09-30.mp4', 'video', 'Se ve: una mano muestra un cubrevolante negro.\nSe escucha: este es el cubrevolante.', { grupo, duracion: 68 }),
    archivo('foto-auto-terminado.jpg', 'imagen', 'FUNDAS NORTE', { grupo, descripcion: 'Auto con las fundas puestas.' }),
  ]
}

function conversacionDePablo(): ArchivoMaterial[] {
  const grupo = '2 - Pidió precio y no siguió - Pablo'
  return [
    archivo('chat de Pablo.txt', 'texto', CHAT_PABLO, { grupo }),
    archivo('PTT-20260925-WA0003.opus', 'audio', 'Hola Pablo, para el Cronos tenemos dos líneas.', { grupo, duracion: 21, dudosa: true }),
    archivo('IMG-20260925-WA0004.jpg', 'imagen', '', { grupo, problema: 'No pudimos leer este archivo.' }),
  ]
}

function estadoCon(archivos: ArchivoMaterial[], textos: string[] = [], chat: string | null = null): EstadoCuestionario {
  const estado = estadoInicial('Tapicería Norte')
  estado.etapa = 'material'
  estado.chat = chat
  estado.material.archivos = archivos
  estado.material.textos = textos.map((texto, i) => ({ id: `t${i}`, texto }))
  return estado
}

describe('el material separado por conversación', () => {
  it('pone primero el chat del principio, después los sueltos, cada conversación y los textos pegados', () => {
    const suelto = archivo('Lista de precios octubre.pdf', 'pdf', 'Fundas de cuero ecológico — $80.000')
    const estado = estadoCon([...conversacionDeLaura(), suelto, ...conversacionDePablo()], ['Horarios: lunes a viernes de 9 a 18.'], 'Cliente: hola, precio de fundas para un Gol?')
    const texto = armarTextoDelMaterial(estado)
    const titulos = texto.split('\n').filter((linea) => /^#{2,3} /.test(linea))
    assert.deepEqual(titulos, [
      '### Chat del principio',
      '## Archivos sueltos',
      '### Lista de precios octubre.pdf',
      '## Conversación: 1 - Venta cerrada - Laura',
      '### Chat: _chat.txt',
      '### Otros archivos de esta conversación',
      '## Conversación: 2 - Pidió precio y no siguió - Pablo',
      '### Chat: chat de Pablo.txt',
      '## Textos pegados',
      '### Texto pegado 1',
    ])
    assert.match(texto, /\(6 archivos: el chat, 1 audio, 2 fotos, 1 PDF, 1 video, 1 que el chat no nombra\)/)
    assert.match(texto, /\(3 archivos: el chat, 1 audio, 1 foto, 1 sin leer\)/)
  })

  it('cada adjunto va en el lugar donde el chat lo nombra, con lo automático entre ⟪ y ⟫', () => {
    const texto = armarTextoDelMaterial(estadoCon(conversacionDeLaura()))
    assert.match(
      texto,
      /Tapicería Norte: \[Audio «00000043-AUDIO-2026-09-16-10-06-10\.opus», 0:13, transcripción automática: ⟪Hola Laura, las de cuero ecológico salen 80 mil de lista\.⟫\]/,
    )
    // Lo que escribió el dueño alrededor de la marca queda tal cual.
    assert.match(texto, /Así quedan con el vivo rojo \[Foto «00000056-PHOTO-2026-09-16-11-14-26\.jpg»: ⟪Asiento delantero con funda negra y costura roja\.⟫\]/)
    assert.match(texto, /Comprobante\.pdf • 1 página \[PDF «00000070-Comprobante\.pdf»: Transferencia a Tapicería Norte por \$72\.000\]/)
    assert.match(texto, /\[Video «00000084-VIDEO-2026-09-16-12-09-30\.mp4», 1:08, descripción y transcripción automáticas: ⟪Se ve: una mano muestra un cubrevolante negro\.\nSe escucha: este es el cubrevolante\.⟫\]/)
    // Lo que el chat nombra y no se subió queda dicho, y no figura ninguna marca sin reemplazar.
    assert.match(texto, /Laura: \[Adjunto «00000091-PHOTO-2026-09-16-12-15-00\.jpg»: no está entre lo que subiste\]/)
    assert.doesNotMatch(texto, /<adjunto:/)
    // Lo que ningún chat nombra va abajo: el texto copiado es literal, la descripción no.
    assert.match(texto, /### Otros archivos de esta conversación\n\n#### foto-auto-terminado\.jpg\nFUNDAS NORTE ⟪Auto con las fundas puestas\.⟫/)
  })

  it('reconoce las marcas de Android, en inglés y en portugués, y marca la transcripción dudosa', () => {
    const texto = armarTextoDelMaterial(estadoCon(conversacionDePablo()))
    assert.match(texto, /Tapicería Norte: \[Audio «PTT-20260925-WA0003\.opus», 0:21, transcripción automática, puede tener errores: ⟪Hola Pablo/)
    assert.match(texto, /Tapicería Norte: \[Foto «IMG-20260925-WA0004\.jpg»: no se pudo leer\]\nMirá cómo queda/)
    assert.doesNotMatch(texto, /archivo adjunto/)

    const grupo = 'Otros idiomas'
    const chat = `[1/3/26, 10:15:02] Ana: <attached: 00000001-PHOTO.jpg>
[1/3/26, 10:16:40] Shop: <anexado: 00000002-AUDIO.opus>
01/03/2026, 10:17 - Shop: DOC-0003.pdf (file attached)
01/03/2026, 10:18 - Shop: DOC-0004.pdf (arquivo anexado)`
    const otros = armarTextoDelMaterial(
      estadoCon([
        archivo('chat.txt', 'texto', chat, { grupo }),
        archivo('00000001-PHOTO.jpg', 'imagen', 'uno', { grupo }),
        archivo('00000002-AUDIO.opus', 'audio', 'dos', { grupo }),
        archivo('DOC-0003.pdf', 'pdf', 'tres', { grupo }),
        archivo('DOC-0004.pdf', 'pdf', 'cuatro', { grupo }),
      ]),
    )
    assert.match(otros, /Ana: \[Foto «00000001-PHOTO\.jpg»: uno\]/)
    assert.match(otros, /Shop: \[Audio «00000002-AUDIO\.opus», transcripción automática: ⟪dos⟫\]/)
    assert.match(otros, /Shop: \[PDF «DOC-0003\.pdf»: tres\]/)
    assert.match(otros, /Shop: \[PDF «DOC-0004\.pdf»: cuatro\]/)
    assert.doesNotMatch(otros, /Otros archivos de esta conversación/)
  })

  it('el nombre del archivo y el de la marca coinciden aunque cambien espacios, guiones o acentos', () => {
    const grupo = 'Nombres raros'
    const chat = `[1/3/26, 10:15:02] Ana: Hola
[1/3/26, 10:16:40] Shop: <adjunto: Lista${ESPACIO_DURO}de  precios${GUION_DURO}2026.pdf>
[1/3/26, 10:17:00] Shop: <adjunto: Catálogo.pdf>`
    const texto = armarTextoDelMaterial(
      estadoCon([
        archivo('chat.txt', 'texto', chat, { grupo }),
        archivo('Lista de precios-2026.pdf', 'pdf', 'Fundas $80.000', { grupo }),
        archivo('Catálogo.pdf', 'pdf', 'Modelos', { grupo }),
      ]),
    )
    assert.match(texto, /\[PDF «Lista de precios-2026\.pdf»: Fundas \$80\.000\]/)
    assert.match(texto, /\[PDF «Catálogo\.pdf»: Modelos\]/)
    assert.doesNotMatch(texto, /no está entre lo que subiste/)
  })

  it('un adjunto largo no corta el chat: va completo abajo', () => {
    const grupo = 'Con catálogo'
    const largo = 'Modelo y precio\n'.repeat(200)
    const chat = '[1/3/26, 10:15:02] Ana: Hola\n[1/3/26, 10:16:40] Shop: te paso la lista <adjunto: lista.pdf>'
    const texto = armarTextoDelMaterial(estadoCon([archivo('chat.txt', 'texto', chat, { grupo }), archivo('lista.pdf', 'pdf', largo.trim(), { grupo })]))
    assert.match(texto, /te paso la lista \[PDF «lista\.pdf»: es largo; está completo más abajo, en «Otros archivos de esta conversación»\]/)
    assert.match(texto, /### Otros archivos de esta conversación\n\n#### lista\.pdf\nModelo y precio\nModelo y precio/)
  })

  it('lo que todavía no se leyó, los stickers y lo que no se puede leer quedan dichos en su lugar', () => {
    const grupo = 'Varios'
    const chat = `[1/3/26, 10:15:02] Ana: <adjunto: a.opus>
[1/3/26, 10:15:03] Ana: <adjunto: 00000005-STICKER-2026.webp>
[1/3/26, 10:15:04] Ana: <adjunto: planilla.xls>
[1/3/26, 10:15:05] Ana: <adjunto: v.mp4>
[1/3/26, 10:15:06] Ana: <adjunto: contacto.vcf>`
    const texto = armarTextoDelMaterial(
      estadoCon([
        archivo('chat.txt', 'texto', chat, { grupo }),
        archivo('a.opus', 'audio', null, { grupo }),
        archivo('00000005-STICKER-2026.webp', 'imagen', '', { grupo }),
        archivo('planilla.xls', 'otro', '', { grupo, problema: 'Los Word y Excel viejos no los podemos leer.' }),
        archivo('v.mp4', 'video', '', { grupo, problema: 'No pudimos ver este video.' }),
        archivo('contacto.vcf', 'texto', 'BEGIN:VCARD\nFN:Proveedor de cueros', { grupo }),
      ]),
    )
    assert.match(texto, /\[Audio «a\.opus»: todavía no se escuchó\]/)
    assert.match(texto, /\[Sticker «00000005-STICKER-2026\.webp»\]/)
    assert.match(texto, /\[Archivo «planilla\.xls»: no se puede leer este tipo de archivo\]/)
    assert.match(texto, /\[Video «v\.mp4»: no se pudo ver\]/)
    assert.match(texto, /\[Archivo «contacto\.vcf»: BEGIN:VCARD\nFN:Proveedor de cueros\]/)
  })

  it('una conversación sin chat lista sus archivos en el orden en que se subieron', () => {
    const grupo = 'Capturas de Marta'
    const texto = armarTextoDelMaterial(
      estadoCon([archivo('captura 1.png', 'imagen', 'Cliente: hola', { grupo }), archivo('captura 2.png', 'imagen', 'Negocio: hola, ¿qué modelo?', { grupo })]),
    )
    assert.equal(
      texto,
      '## Conversación: Capturas de Marta\n(2 archivos: 2 fotos)\n\n### captura 1.png\nCliente: hola\n\n### captura 2.png\nNegocio: hola, ¿qué modelo?',
    )
  })

  it('sin conversaciones, el material sale igual que antes de que existieran', () => {
    const estado = estadoCon(
      [archivo('guion.pdf', 'pdf', 'El tiempo de fabricación es de 5 días.', { grupo: undefined, hash: undefined }), archivo('rota.png', 'imagen', '', { problema: 'No pudimos leer este archivo.' })],
      ['Horarios: de 9 a 18.'],
      'Cliente: hola',
    )
    assert.equal(
      armarTextoDelMaterial(estado),
      '### Chat del principio\nCliente: hola\n\n### guion.pdf\nEl tiempo de fabricación es de 5 días.\n\n### Texto pegado 1\nHorarios: de 9 a 18.',
    )
  })
})

describe('las conversaciones no se mezclan', () => {
  it('un adjunto solo se busca entre los archivos de su conversación', () => {
    // Las dos conversaciones nombran un archivo que se llama igual: cada chat recibe el suyo.
    const chat = (quien: string) => `[1/3/26, 10:15:02] ${quien}: Hola\n[1/3/26, 10:16:40] Shop: <adjunto: Presupuesto.pdf>`
    const texto = armarTextoDelMaterial(
      estadoCon([
        archivo('_chat.txt', 'texto', chat('Ana'), { grupo: 'Ana' }),
        archivo('Presupuesto.pdf', 'pdf', 'Total Ana: $100', { grupo: 'Ana' }),
        archivo('_chat.txt', 'texto', chat('Beto'), { grupo: 'Beto' }),
        archivo('Presupuesto.pdf', 'pdf', 'Total Beto: $999', { grupo: 'Beto' }),
      ]),
    )
    const [, deAna, deBeto] = texto.split('## Conversación: ')
    assert.match(deAna, /Total Ana: \$100/)
    assert.doesNotMatch(deAna, /Beto/)
    assert.match(deBeto, /Total Beto: \$999/)
    assert.doesNotMatch(deBeto, /Total Ana/)
  })

  it('un archivo suelto que un solo chat nombra pasa a la conversación de ese chat', () => {
    const chatAna = '[1/3/26, 10:15:02] Ana: Hola\n[1/3/26, 10:16:40] Shop: <adjunto: IMG-0001.jpg>\n[1/3/26, 10:17:00] Shop: <adjunto: logo.png>'
    const chatBeto = '[1/3/26, 10:15:02] Beto: Hola\n[1/3/26, 10:16:40] Shop: <adjunto: logo.png>'
    const archivos = [
      archivo('ana.txt', 'texto', chatAna, { grupo: 'ana' }),
      archivo('beto.txt', 'texto', chatBeto, { grupo: 'beto' }),
      archivo('IMG-0001.jpg', 'imagen', 'foto de Ana'),
      // Lo nombran dos chats: no se puede saber de cuál es y queda suelto.
      archivo('logo.png', 'imagen', 'logo'),
      archivo('precios.pdf', 'pdf', 'lista'),
    ]
    const grupos = grupoEfectivo(archivos)
    assert.deepEqual(
      archivos.map((a) => grupos.get(a.id)),
      ['ana', 'beto', 'ana', null, null],
    )
    const texto = textoDeArchivos(archivos)
    assert.match(texto, /Shop: \[Foto «IMG-0001\.jpg»: foto de Ana\]/)
    assert.match(texto, /## Archivos sueltos\n\n### logo\.png\nlogo\n\n### precios\.pdf\nlista/)
  })

  it('la misma conversación subida dos veces (mismo chat) se le muestra a Claude una sola vez, con los adjuntos de las dos', () => {
    const chat = '[1/3/26, 10:15:02] Ana: Hola\n[1/3/26, 10:16:40] Shop: <adjunto: a.opus>'
    const archivos = [
      archivo('_chat.txt', 'texto', chat, { grupo: 'Ana', hash: 'mismo-chat' }),
      archivo('_chat.txt', 'texto', chat, { grupo: 'WhatsApp Chat - Ana', hash: 'mismo-chat' }),
      archivo('a.opus', 'audio', 'hola Ana', { grupo: 'WhatsApp Chat - Ana', duracion: 3 }),
    ]
    const [original, copia] = conversaciones(archivos)
    assert.equal(copia.repiteA, 'Ana')
    assert.equal(original.repiteA, null)
    const texto = textoDeArchivos(archivos)
    assert.equal(texto.split('### Chat: ').length, 2)
    assert.match(texto, /\[Audio «a\.opus», 0:03, transcripción automática: ⟪hola Ana⟫\]/)
    assert.match(texto, /## Conversación: WhatsApp Chat - Ana\n\(es la misma conversación que «Ana»/)
  })

  it('esChat distingue el chat exportado de un documento de texto', () => {
    assert.equal(esChat(archivo('_chat.txt', 'texto', CHAT_LAURA)), true)
    assert.equal(esChat(archivo('guion.txt', 'texto', 'Hola, gracias por escribirnos.')), false)
    assert.equal(esChat(archivo('a.opus', 'audio', CHAT_LAURA)), false)
  })

  it('dice dónde se mandó un adjunto y si es de una conversación con chat', () => {
    const archivos = [...conversacionDeLaura(), archivo('suelto.pdf', 'pdf', null), archivo('captura.png', 'imagen', null, { grupo: 'Sin chat' })]
    const foto = archivos[2]
    assert.deepEqual(contextoDeAdjunto(archivos, foto), {
      conversacion: '1 - Venta cerrada - Laura',
      lineas:
        '[16/9/26, 10:05:44 a. m.] Laura: Hola! Precio de fundas para Gol Trend?\n' +
        '[16/9/26, 10:06:10 a. m.] Tapicería Norte: <adjunto: 00000043-AUDIO-2026-09-16-10-06-10.opus>\n' +
        '[16/9/26, 11:14:26 a. m.] Tapicería Norte: Así quedan con el vivo rojo <adjunto: 00000056-PHOTO-2026-09-16-11-14-26.jpg>',
    })
    assert.equal(contextoDeAdjunto(archivos, archivos[6]), null)
    assert.equal(esAdjuntoDeConversacion(archivos, foto), true)
    // El chat mismo, un suelto y un archivo de una conversación sin chat: si fallan, el dueño los puede cambiar.
    assert.equal(esAdjuntoDeConversacion(archivos, archivos[0]), false)
    assert.equal(esAdjuntoDeConversacion(archivos, archivos[6]), false)
    assert.equal(esAdjuntoDeConversacion(archivos, archivos[7]), false)
  })
})

describe('lo automático nunca pasa por texto del dueño', () => {
  it('soloLiteral tapa transcripciones y descripciones, y deja lo escrito', () => {
    const literal = soloLiteral(armarTextoDelMaterial(estadoCon([...conversacionDeLaura(), ...conversacionDePablo()])))
    for (const automatico of ['cuero ecológico salen 80 mil', 'Asiento delantero', 'una mano muestra', 'este es el cubrevolante', 'Auto con las fundas', 'para el Cronos tenemos']) {
      assert.ok(!literal.includes(automatico), automatico)
    }
    for (const escrito of ['Así quedan con el vivo rojo', 'Transferencia a Tapicería Norte por $72.000', 'FUNDAS NORTE', 'cuanto sale para un Cronos?', 'Mirá cómo queda']) {
      assert.ok(literal.includes(escrito), escrito)
    }
  })

  it('el chat del principio, que ya trae sus ⟪⟫, sigue tapado en la versión literal', () => {
    const delPrincipio = textoDeArchivos(conversacionDeLaura().map((a) => ({ ...a, etapa: 'pedido_chat' as const })))
    const estado = estadoCon([], [], `Cliente: hola\n\n${delPrincipio}`)
    const literal = soloLiteral(armarTextoDelMaterial(estado))
    assert.ok(literal.includes('Así quedan con el vivo rojo'))
    assert.ok(!literal.includes('cuero ecológico salen 80 mil'))
  })

  it('un ⟪ escrito por una persona no tapa lo que sigue', () => {
    const estado = estadoCon(
      [archivo('guion ⟪v2⟫.txt', 'texto', 'Precio ⟪de lista: $80.000'), archivo('b.opus', 'audio', 'esto lo ⟫ dijo un audio ⟪', { duracion: 2 })],
      ['Seña ⟪ 50% ⟫ por transferencia'],
    )
    const texto = armarTextoDelMaterial(estado)
    const literal = soloLiteral(texto)
    assert.ok(literal.includes('Precio «de lista: $80.000'))
    assert.ok(literal.includes('Seña « 50% » por transferencia'))
    assert.ok(!literal.includes('dijo un audio'))
    // Los únicos corchetes dobles que quedan son los del audio.
    assert.equal(texto.split('⟪').length, 2)
    assert.equal(texto.split('⟫').length, 2)
  })

  it('reconoce los rótulos que pone la app, también con las comillas ya unificadas', () => {
    assert.equal(tieneMarcadorDeLaApp('Así quedan [Foto «0001.jpg»: FUNDAS NORTE]'), true)
    assert.equal(tieneMarcadorDeLaApp('te paso [PDF "lista.pdf": es largo'), true)
    assert.equal(tieneMarcadorDeLaApp('⟪…⟫'), true)
    assert.equal(tieneMarcadorDeLaApp('Trabajamos solo con cuero ecológico [ver foto]'), false)
  })
})

describe('material que no entra entero', () => {
  it('acorta primero los documentos largos y deja los chats y los textos pegados', () => {
    const chat = `25/9/26, 2:41 p. m. - Pablo: cuanto sale para un Cronos?\n${'25/9/26, 3:00 p. m. - Pablo: sigo acá\n'.repeat(2000)}`.trim()
    const estado = estadoCon(
      [
        archivo('catalogo.pdf', 'pdf', 'Modelo A: $100\n'.repeat(20_000).trim()),
        archivo('manual.docx', 'texto', 'Paso a paso\n'.repeat(15_000).trim()),
        archivo('chat.txt', 'texto', chat, { grupo: 'Pablo' }),
      ],
      ['Horarios: lunes a viernes de 9 a 18.'],
    )
    const texto = armarTextoDelMaterial(estado)
    assert.ok(texto.length <= LIMITE_CARACTERES_MATERIAL, `quedó en ${texto.length}`)
    assert.match(texto, /\[Se recortó este archivo: tenía 299\.999 caracteres y se dejaron los primeros/)
    // Lo del final no se perdió.
    assert.ok(texto.includes(chat))
    assert.ok(texto.endsWith('### Texto pegado 1\nHorarios: lunes a viernes de 9 a 18.'))
    assert.match(recorteDelMaterial(estado) ?? '', /«catalogo\.pdf» \(de 299\.999 a unos/)
  })

  it('si ni así entra, corta al final de una línea y cierra lo automático que quedó abierto', () => {
    const estado = estadoCon([archivo('largo.opus', 'audio', 'bla bla bla\n'.repeat(40_000), { duracion: 900 })], ['x'.repeat(1000)])
    const texto = armarTextoDelMaterial(estado)
    assert.match(texto, /\n\n\[Se recortó el material: tenía [\d.]+ caracteres y se dejaron los primeros 400\.000\.\]$/)
    const literal = soloLiteral(texto)
    assert.ok(!literal.includes('bla bla'))
    assert.match(recorteDelMaterial(estado) ?? '', /el final del material/)
  })

  it('el material que entra no tiene recorte', () => {
    assert.equal(recorteDelMaterial(estadoCon(conversacionDeLaura())), null)
  })
})

describe('el material en cierre.md', () => {
  it('cuenta conversaciones y sueltos, y dice qué faltó en cada una', () => {
    const estado = estadoCon([...conversacionDeLaura(), ...conversacionDePablo(), archivo('Lista de precios.pdf', 'pdf', 'Fundas $80.000')], ['uno'])
    const resumen = resumenDeMaterial(estado)
    assert.equal(resumen.conversaciones, 2)
    assert.equal(resumen.sueltos, 1)
    const cierre = armarReporteCierre(estado, [])
    assert.match(cierre, /- Material: 2 conversación\(es\), 1 archivo\(s\) suelto\(s\), 1 texto\(s\) pegado\(s\)/)
    assert.match(cierre, /## Material\n/)
    assert.match(cierre, /### 1 - Venta cerrada - Laura\n\n- Chat: sí \(«_chat\.txt»\)\n- Adjuntos: 1 audio \(0:13 min\), 1 video \(1:08 min\), 2 fotos, 1 PDF/)
    assert.match(cierre, /- El chat nombra y no se subió: «00000091-PHOTO-2026-09-16-12-15-00\.jpg»/)
    assert.match(cierre, /- Transcripciones dudosas \(conviene escucharlas\): «PTT-20260925-WA0003\.opus»/)
    assert.match(cierre, /- No se pudo leer: «IMG-20260925-WA0004\.jpg» \(No pudimos leer este archivo\.\)/)
    assert.match(cierre, /### Archivos sueltos\n\n- «Lista de precios\.pdf» \(pdf\)/)
  })
})
