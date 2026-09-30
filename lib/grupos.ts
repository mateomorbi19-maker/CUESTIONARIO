import { LIMITE_LARGO_GRUPO, LIMITE_LARGO_NOMBRE } from './limites'

/**
 * A qué conversación pertenece cada archivo.
 *
 * Una conversación es un «grupo»: la carpeta de un chat, el .zip que exporta WhatsApp o la que la
 * persona arma a mano. Todo acá es puro (sin Node ni motor) porque lo usan los dos lados: el
 * navegador, para agrupar lo que se elige o se arrastra, y el servidor, para lo que viene
 * adentro de un .zip. Ante la duda se separa: separar de más no hace daño, juntar de más mezcla
 * a dos clientes.
 */

// Marcas de dirección y BOM: WhatsApp las mete delante de nombres y adjuntos.
const INVISIBLES = /[​-‏‪-‮⁠-⁩﻿]/g

/**
 * `conSeparador`: deja pasar « / » (con sus espacios), que es lo que pone gruposDeRutas entre dos
 * carpetas cuando hace falta la ruta para distinguirlas («A / Cliente»). Así el nombre que calcula
 * el navegador es el mismo que guarda el servidor después de sanearlo de nuevo.
 */
function limpiar(nombre: string, conSeparador: boolean): string {
  return (
    nombre
      .normalize('NFC')
      // Los corchetes dobles marcan lo que escribió la máquina (transcripciones, descripciones). Un
      // nombre que los traiga haría pasar por automático el texto del dueño que sigue.
      .replace(/⟪/g, '«')
      .replace(/⟫/g, '»')
      // Primero los espacios: si se sacaran antes los caracteres de control, «a\tb» quedaría «ab».
      .replace(/[\s  ]/g, ' ')
      // U+FFFD: así quedan en el disco las marcas invisibles que WhatsApp pone alrededor del
      // teléfono en el nombre del .zip cuando el archivo pasó por un programa que no las entendió.
      .replace(/[\p{Cc}\p{Cf}�]/gu, '')
      .replace(/[‐-―]/g, '-')
      .replace(/ {2,}/g, ' ')
      // Un nombre nunca es una ruta: una barra pegada a las palabras se cambia por un guion.
      .replace(/ \/ |[/\\]/g, (barra) => (conSeparador && barra === ' / ' ? barra : ' - '))
      .replace(/ {2,}/g, ' ')
      .replace(/^[ .]+|[ .]+$/g, '')
  )
}

/** Corta en puntos de código: cortar por unidades UTF-16 puede dejar medio emoji. */
function cortar(texto: string, maximo: number): string {
  const puntos = Array.from(texto)
  return puntos.length <= maximo ? texto : puntos.slice(0, maximo).join('')
}

/** El nombre de una conversación, limpio. null si no queda nada: el archivo va suelto. */
export function sanearGrupo(nombre: string | null | undefined): string | null {
  if (typeof nombre !== 'string') return null
  const limpio = cortar(limpiar(nombre, true), LIMITE_LARGO_GRUPO).replace(/[ .]+$/, '')
  return limpio || null
}

/** El nombre de un archivo, limpio y sin carpetas. Conserva la extensión aunque haya que acortarlo. */
export function sanearNombre(nombre: string): string {
  const limpio = limpiar(typeof nombre === 'string' ? nombre : '', false)
  if (!limpio) return 'archivo'
  if (Array.from(limpio).length <= LIMITE_LARGO_NOMBRE) return limpio
  // Sin la extensión, el archivo cortado ya no se sabe qué es.
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(limpio)?.[0] ?? ''
  const tronco = cortar(limpio.slice(0, limpio.length - extension.length), LIMITE_LARGO_NOMBRE - extension.length)
  return `${tronco.replace(/[ .]+$/, '')}${extension}` || 'archivo'
}

/**
 * La misma clave para el nombre de un archivo y para el nombre que figura en la marca del chat
 * («<adjunto: X>»). Sin esto, un espacio duro o un guion raro en uno de los dos lados hace que el
 * adjunto «no esté entre lo que subiste» aunque se haya subido.
 */
export function claveDeNombre(nombre: string): string {
  return sanearNombre(nombre)
}

/** Parte una ruta en segmentos. No sanea: solo saca lo que no es un nombre ('', '.', '..', 'C:'). */
export function partesDeRuta(ruta: string): string[] {
  return ruta
    .split(/[/\\]/)
    .filter((parte, i) => parte !== '' && parte !== '.' && parte !== '..' && !(i === 0 && /^[A-Za-z]:$/.test(parte)))
}

const NOMBRES_DE_SISTEMA = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized'])

/** Lo que Mac y Windows dejan en las carpetas y en los .zip: no es material de nadie. */
export function esArchivoDeSistema(ruta: string): boolean {
  return partesDeRuta(ruta).some(
    (parte) => parte === '__MACOSX' || parte.startsWith('._') || NOMBRES_DE_SISTEMA.has(parte.toLowerCase()),
  )
}

// Una línea de chat exportado. iPhone: «[16/9/26, 10:05:44 a. m.] Laura: Hola». Android:
// «16/9/26, 10:05 a. m. - Laura: Hola».
const LINEA_IPHONE = /^\[\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},? \d{1,2}:\d{2}(?::\d{2})?[^\]]*\] [^:]{1,80}: /
const LINEA_ANDROID = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)? - [^:]{1,80}: /i
const MARCA_DE_ADJUNTO =
  /<(?:adjunto|attached|anexado|anexo|allegato|pièce jointe|Anhang)\s*:\s*[^>\n]+>|\.[A-Za-z0-9]{2,5} \((?:archivo adjunto|file attached|arquivo anexado|fichier joint|allegato|Datei angehängt)\)/i

/**
 * ¿Es un chat exportado de WhatsApp? Mira el principio del texto: alcanza con los primeros 4 KB.
 * Un «notas.txt» cualquiera no es un chat, y tratarlo como tal convertiría su carpeta en una
 * conversación que se traga a las demás.
 */
export function esChatDeWhatsApp(principio: string): boolean {
  const lineas = principio
    .replace(INVISIBLES, '')
    .split(/\r\n?|\n/)
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(0, 50)
  let mensajes = 0
  for (const linea of lineas) {
    if (MARCA_DE_ADJUNTO.test(linea)) return true
    if (LINEA_IPHONE.test(linea) || LINEA_ANDROID.test(linea)) mensajes++
    if (mensajes >= 2) return true
  }
  return false
}

const clave = (carpetas: string[]) => carpetas.join('/')

function prefijoComun(a: string[], b: string[]): string[] {
  let comun = 0
  while (comun < a.length && comun < b.length && a[comun] === b[comun]) comun++
  return a.slice(0, comun)
}

/**
 * El grupo de cada ruta, en el mismo orden. null: va suelto.
 *
 * `esChat[i]` dice si la ruta i es un chat de verdad (el navegador lee los primeros 4 KB de cada
 * .txt; el servidor, el contenido). Si no se pasa, vale cualquier .txt.
 *
 * Regla: la conversación de un archivo es la carpeta más alta que lo contiene y que tiene, con
 * todo lo de adentro, exactamente un chat. Así «Audios y videos» queda en su conversación, el
 * chat guardado en una subcarpeta propia junta a sus hermanas, y la carpeta madre (con varios
 * chats) no es conversación de nadie. Si no hay ningún chat, cada carpeta del primer nivel es un
 * grupo. Si hay chats pero ninguna carpeta del archivo tiene uno solo, queda suelto.
 */
export function gruposDeRutas(rutas: string[], esChat?: boolean[]): (string | null)[] {
  const carpetas = rutas.map((ruta) => partesDeRuta(ruta).slice(0, -1))
  const deSistema = rutas.map(esArchivoDeSistema)
  const chat = rutas.map((ruta, i) => !deSistema[i] && (esChat ? esChat[i] === true : /\.txt$/i.test(ruta)))

  // Los archivos de sistema no cuentan: un «__MACOSX/» al lado de la carpeta cambiaría la raíz.
  const conCarpeta = carpetas.filter((c, i) => c.length > 0 && !deSistema[i])
  const raiz = conCarpeta.reduce<string[]>((comun, c) => prefijoComun(comun, c), conCarpeta[0] ?? [])

  // Cuántos chats hay debajo de cada carpeta, contando todos sus niveles.
  const chatsDebajo = new Map<string, number>()
  carpetas.forEach((c, i) => {
    if (!chat[i]) return
    for (let largo = 1; largo <= c.length; largo++) {
      const k = clave(c.slice(0, largo))
      chatsDebajo.set(k, (chatsDebajo.get(k) ?? 0) + 1)
    }
  })
  const hayChats = chat.some(Boolean)

  // La carpeta más alta con un solo chat, por archivo.
  const cima = carpetas.map((c) => {
    if (!hayChats) return null
    for (let largo = 1; largo <= c.length; largo++) {
      if (chatsDebajo.get(clave(c.slice(0, largo))) === 1) return c.slice(0, largo)
    }
    return null
  })

  // Dentro de esa cima, la conversación es la carpeta más ajustada que contiene todo lo suyo: si
  // lo único que hay en «A» es «A/Cliente», la conversación se llama «Cliente» y no «A».
  const ajustada = new Map<string, string[]>()
  cima.forEach((c, i) => {
    if (!c || deSistema[i]) return
    const k = clave(c)
    const actual = ajustada.get(k)
    ajustada.set(k, actual ? prefijoComun(actual, carpetas[i]) : carpetas[i])
  })

  const elegidas = carpetas.map((c, i): string[] | null => {
    if (c.length === 0) return null
    if (hayChats) {
      const tope = cima[i]
      return tope ? (ajustada.get(clave(tope)) ?? tope) : null
    }
    const primera = c.length > raiz.length ? c.slice(0, raiz.length + 1) : raiz
    return primera.length ? primera : null
  })

  // Dos carpetas distintas que terminan igual («A/Cliente» y «B/Cliente») son dos conversaciones:
  // con el mismo nombre se mezclarían.
  const porNombre = new Map<string, Set<string>>()
  for (const e of elegidas) {
    if (!e) continue
    const nombre = e[e.length - 1]
    porNombre.set(nombre, (porNombre.get(nombre) ?? new Set<string>()).add(clave(e)))
  }

  return elegidas.map((e) => {
    if (!e) return null
    const nombre = e[e.length - 1]
    const repetido = (porNombre.get(nombre)?.size ?? 0) > 1
    // Desde la raíz común: «A / Cliente». Si la carpeta es la raíz misma, su propio nombre.
    const desdeLaRaiz = e.slice(Math.min(raiz.length, e.length - 1))
    return sanearGrupo(repetido ? desdeLaRaiz.join(' / ') : nombre)
  })
}

/** El nombre de la conversación de un .zip: su nombre sin la extensión. */
export function grupoDeZip(nombreDelZip: string): string | null {
  const nombre = partesDeRuta(nombreDelZip).at(-1) ?? ''
  return sanearGrupo(nombre.replace(/\.[^.]*$/, ''))
}

/** «Nombre (2)», «Nombre (3)»…: el primero que no esté usado. */
export function grupoLibre(nombre: string, usados: Iterable<string | null>): string {
  const ocupados = new Set(usados)
  for (let n = 2; ; n++) {
    const sufijo = ` (${n})`
    const candidato = `${cortar(nombre, LIMITE_LARGO_GRUPO - sufijo.length).replace(/[ .]+$/, '')}${sufijo}`
    if (!ocupados.has(candidato)) return candidato
  }
}
