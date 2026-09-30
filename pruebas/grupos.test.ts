import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  claveDeNombre,
  esArchivoDeSistema,
  esChatDeWhatsApp,
  grupoDeZip,
  grupoLibre,
  gruposDeRutas,
  partesDeRuta,
  sanearGrupo,
  sanearNombre,
} from '../lib/grupos'

// Los caracteres invisibles se arman por código: escritos literales no se ven al revisar la prueba.
const AISLAR = String.fromCharCode(0x2068)
const FIN_AISLAR = String.fromCharCode(0x2069)
const ESPACIO_DURO = String.fromCharCode(0x00a0)
const ESPACIO_FINO = String.fromCharCode(0x202f)
const GUION_DURO = String.fromCharCode(0x2011)
const LRM = String.fromCharCode(0x200e)

describe('gruposDeRutas', () => {
  const casos: [string, string[], (string | null)[]][] = [
    [
      'la carpeta madre da una conversación por subcarpeta, con sus «Audios y videos» adentro',
      ['M/1 - Venta/chat.txt', 'M/1 - Venta/Audios y videos/a.opus', 'M/1 - Venta/f.jpg', 'M/2 - Local/chat.txt', 'M/2 - Local/Audios y videos/v.mp4'],
      ['1 - Venta', '1 - Venta', '1 - Venta', '2 - Local', '2 - Local'],
    ],
    ['una conversación sola', ['1 - Venta/chat.txt', '1 - Venta/Audios y videos/a.opus'], ['1 - Venta', '1 - Venta']],
    ['archivos sin carpeta quedan sueltos', ['_chat.txt', '00000043-AUDIO-x.opus'], [null, null]],
    ['el .zip de una carpeta', ['WhatsApp Chat - Ana/_chat.txt', 'WhatsApp Chat - Ana/1.jpg'], ['WhatsApp Chat - Ana', 'WhatsApp Chat - Ana']],
    ['sin ningún chat, la carpeta es el grupo', ['Catálogo/a.jpg', 'Catálogo/b.jpg'], ['Catálogo', 'Catálogo']],
    ['sin ningún chat, cada carpeta del primer nivel', ['Fotos/Autos/a.jpg', 'Fotos/Motos/b.jpg'], ['Autos', 'Motos']],
    ['dos carpetas que terminan igual no se juntan', ['A/Cliente/chat.txt', 'B/Cliente/chat.txt'], ['A / Cliente', 'B / Cliente']],
    [
      'el chat guardado en una subcarpeta propia junta a sus hermanas',
      ['1 - Venta/Chat/_chat.txt', '1 - Venta/Audios/a.opus'],
      ['1 - Venta', '1 - Venta'],
    ],
    [
      'rutas de Windows y con la carpeta madre más arriba',
      ['C:\\Users\\yo\\Chats\\Laura\\_chat.txt', 'C:\\Users\\yo\\Chats\\Laura\\foto.jpg', 'C:\\Users\\yo\\Chats\\Pablo\\_chat.txt'],
      ['Laura', 'Laura', 'Pablo'],
    ],
  ]
  for (const [nombre, rutas, esperado] of casos) {
    it(nombre, () => assert.deepEqual(gruposDeRutas(rutas), esperado))
  }

  it('un notas.txt en la madre no la convierte en conversación, y lo suelto en la madre queda suelto', () => {
    const rutas = ['M/notas.txt', 'M/lista.pdf', 'M/1/_chat.txt', 'M/1/a.jpg', 'M/2/_chat.txt', 'M/2/Audios/b.opus']
    // El navegador lee el principio de cada .txt y dice cuáles son chats de verdad.
    const esChat = [false, false, true, false, true, false]
    assert.deepEqual(gruposDeRutas(rutas, esChat), [null, null, '1', '1', '2', '2'])
    // Sin ese dato vale cualquier .txt: la madre tiene tres y tampoco es conversación de nadie.
    assert.deepEqual(gruposDeRutas(rutas), [null, null, '1', '1', '2', '2'])
  })

  it('una carpeta sin chat al lado de las conversaciones queda suelta: ante la duda, no se mezcla', () => {
    assert.deepEqual(gruposDeRutas(['M/1/_chat.txt', 'M/2/_chat.txt', 'M/Catálogo/a.jpg']), ['1', '2', null])
  })

  it('con esChat, un .txt que no es un chat no arma conversación', () => {
    assert.deepEqual(gruposDeRutas(['Docs/guion.txt', 'Docs/precios.pdf'], [false, false]), ['Docs', 'Docs'])
  })

  it('lo que deja Mac adentro de un .zip no cuenta como chat ni cambia la raíz', () => {
    const rutas = ['Ana/_chat.txt', 'Ana/1.jpg', '__MACOSX/Ana/._chat.txt', 'Ana/.DS_Store']
    const grupos = gruposDeRutas(rutas)
    assert.deepEqual(grupos.slice(0, 2), ['Ana', 'Ana'])
    assert.equal(grupos.length, 4)
  })
})

describe('sanear nombres', () => {
  it('sanearGrupo saca lo invisible, unifica espacios y guiones y corta en 120', () => {
    // Así viene el nombre del .zip que exporta WhatsApp: el contacto entre marcas de aislamiento.
    assert.equal(sanearGrupo(`WhatsApp Chat - ${AISLAR}+54${ESPACIO_DURO}9${ESPACIO_FINO}11${GUION_DURO}5555${FIN_AISLAR}`), 'WhatsApp Chat - +54 9 11-5555')
    assert.equal(sanearGrupo('  Venta \t cerrada\n - María.  '), 'Venta cerrada - María')
    assert.equal(sanearGrupo('con\u0000control\u0007es'), 'concontroles')
    assert.equal(sanearGrupo('WhatsApp Chat - �+54 9 11 5555�'), 'WhatsApp Chat - +54 9 11 5555')
    assert.equal(sanearGrupo('Ventas/2026\\Laura'), 'Ventas - 2026 - Laura')
    // El separador que pone gruposDeRutas pasa tal cual: el servidor guarda el mismo nombre que calculó el navegador.
    assert.equal(sanearGrupo('A / Cliente'), 'A / Cliente')
    assert.equal(sanearNombre('A / foto.jpg'), 'A - foto.jpg')
    assert.equal(Array.from(sanearGrupo('a'.repeat(300)) ?? '').length, 120)
    // Corta por caracteres enteros: no deja medio emoji.
    assert.equal(sanearGrupo('😀'.repeat(200)), '😀'.repeat(120))
  })

  it('sanearGrupo devuelve null si no queda nada', () => {
    for (const vacio of ['', '   ', '...', `${AISLAR}${FIN_AISLAR}`, null, undefined]) assert.equal(sanearGrupo(vacio), null)
  })

  it('los corchetes dobles no pueden venir en un nombre: son la marca de lo automático', () => {
    assert.equal(sanearGrupo('⟪Laura⟫'), '«Laura»')
    assert.equal(sanearNombre('foto ⟪1⟫.jpg'), 'foto «1».jpg')
  })

  it('sanearNombre conserva la extensión al acortar y nunca queda vacío', () => {
    const largo = sanearNombre(`${'x'.repeat(300)}.pdf`)
    assert.equal(Array.from(largo).length, 200)
    assert.ok(largo.endsWith('.pdf'))
    assert.equal(sanearNombre(''), 'archivo')
    assert.equal(sanearNombre(`${LRM}00000043-AUDIO-2026-09-16.opus`), '00000043-AUDIO-2026-09-16.opus')
  })

  it('claveDeNombre da lo mismo para el archivo y para como lo nombra el chat', () => {
    const enElChat = `Lista${ESPACIO_DURO}de  precios${GUION_DURO}2026.pdf`
    const enElDisco = 'Lista de precios-2026.pdf'
    assert.equal(claveDeNombre(enElChat), claveDeNombre(enElDisco))
    // Una Mac manda los acentos descompuestos (NFD); WhatsApp los escribe compuestos.
    assert.equal(claveDeNombre('Cata\u0301logo.pdf'), claveDeNombre('Catálogo.pdf'))
    assert.notEqual(claveDeNombre('a.jpg'), claveDeNombre('b.jpg'))
  })
})

describe('rutas', () => {
  it('partesDeRuta parte por las dos barras y saca lo que no es un nombre', () => {
    assert.deepEqual(partesDeRuta('C:\\Users\\yo\\chat.txt'), ['Users', 'yo', 'chat.txt'])
    assert.deepEqual(partesDeRuta('/abs/../x/./y.txt'), ['abs', 'x', 'y.txt'])
    assert.deepEqual(partesDeRuta('../../etc/passwd'), ['etc', 'passwd'])
    assert.deepEqual(partesDeRuta(''), [])
  })

  it('esArchivoDeSistema mira todos los segmentos', () => {
    for (const ruta of ['__MACOSX/Ana/._chat.txt', 'Ana/._foto.jpg', 'Ana/.DS_Store', 'Ana/Thumbs.db', 'desktop.ini', 'Ana/.localized']) {
      assert.equal(esArchivoDeSistema(ruta), true, ruta)
    }
    for (const ruta of ['Ana/_chat.txt', 'Ana/foto.jpg', '.env']) assert.equal(esArchivoDeSistema(ruta), false, ruta)
  })

  it('grupoDeZip es el nombre sin la extensión, y grupoLibre el primero que no esté usado', () => {
    assert.equal(grupoDeZip('WhatsApp Chat - Ana.zip'), 'WhatsApp Chat - Ana')
    assert.equal(grupoDeZip('carpeta/Laura v1.2.ZIP'), 'Laura v1.2')
    assert.equal(grupoDeZip('.zip'), null)
    assert.equal(grupoLibre('Ana', ['Ana']), 'Ana (2)')
    assert.equal(grupoLibre('Ana', ['Ana', 'Ana (2)', null]), 'Ana (3)')
    assert.equal(Array.from(grupoLibre('a'.repeat(120), [])).length, 120)
  })
})

describe('esChatDeWhatsApp', () => {
  it('reconoce el formato del iPhone y el de Android', () => {
    const iphone = `${LRM}[16/9/26, 10:05:44${ESPACIO_FINO}a.${ESPACIO_DURO}m.] Laura: Hola! Precio de fundas?\r\n[16/9/26, 10:06:10] Tapicería Norte: ${LRM}<adjunto: 00000043-AUDIO-2026-09-16.opus>\r\n`
    const android = '16/9/26, 10:05 a. m. - Laura: Hola\n16/9/26, 10:06 a. m. - Tapicería Norte: IMG-20260916-WA0001.jpg (archivo adjunto)\n'
    const android24 = '16/09/2026 14:05 - Pablo: cuanto sale?\n16/09/2026 14:07 - Tapicería Norte: Hola Pablo\n'
    for (const chat of [iphone, android, android24]) assert.equal(esChatDeWhatsApp(chat), true, chat)
  })

  it('un texto cualquiera no es un chat', () => {
    assert.equal(esChatDeWhatsApp('Lista de precios\nFundas: $80.000\nCubrevolante: $15.000'), false)
    assert.equal(esChatDeWhatsApp('Reunión 16/9/26, 10:05 - notas: llamar a Laura'), false)
    assert.equal(esChatDeWhatsApp(''), false)
  })
})
