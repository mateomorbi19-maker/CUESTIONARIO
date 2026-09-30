import { claveDeNombre, esChatDeWhatsApp } from '../grupos'
import type { ArchivoMaterial, ContextoAdjunto, EstadoCuestionario, TipoMaterial } from './tipos'

/**
 * El material del dueño, armado como texto para Claude. Todo puro: solo depende del estado.
 *
 * Dos reglas mandan acá:
 *
 * 1. Las conversaciones no se mezclan. Cada una va en su sección, con su chat y con cada foto,
 *    audio, video o PDF puesto en el lugar donde el chat lo nombra. Un adjunto solo se busca
 *    entre los archivos de su misma conversación.
 * 2. Lo que escribió una máquina no pasa por texto del dueño. La transcripción de un audio y la
 *    descripción de una foto o de un video van entre ⟪ y ⟫, y `soloLiteral` las tapa: contra esa
 *    versión se controlan las propuestas y las citas del brief. Un audio mal transcripto nunca
 *    se le propone al dueño como algo que él escribió.
 */

/** Más que esto encarece cada llamada de la entrevista sin sumar. */
export const LIMITE_CARACTERES_MATERIAL = 400_000
// Un contenido más largo que esto, metido en medio del chat, corta la conversación: va abajo.
const LARGO_EN_LINEA = 1_500
// Los documentos más cortos que esto no se tocan al recortar: el ahorro no vale la nota.
const LARGO_PARA_RECORTAR = 5_000
const MINIMO_AL_RECORTAR = 2_000
const PRINCIPIO_PARA_DETECTAR = 20_000

/** El texto que escribió una persona nunca trae los corchetes dobles: solo lo automático queda entre ⟪ y ⟫. */
function literal(texto: string): string {
  return texto.replace(/⟪/g, '«').replace(/⟫/g, '»')
}

function automatico(texto: string): string {
  return `⟪${literal(texto).trim()}⟫`
}

/** El material sin lo que escribió una máquina: contra esto se controla lo que tiene que ser letra del dueño. */
export function soloLiteral(texto: string): string {
  return texto.replace(/⟪[^⟫]*⟫/g, '⟪…⟫')
}

const MARCADOR_DE_LA_APP = /\[(?:Foto|PDF|Audio|Video|Adjunto|Sticker|Archivo) [«"]|[⟪⟫]/

/**
 * ¿El fragmento trae un rótulo puesto por la app («[Foto «0001.jpg»: …]») o un pedazo de algo
 * automático? Eso no lo escribió el dueño: no se le puede proponer como texto suyo. Acepta las
 * comillas rectas porque la comparación literal las unifica.
 */
export function tieneMarcadorDeLaApp(fragmento: string): boolean {
  return MARCADOR_DE_LA_APP.test(fragmento)
}

/** El chat exportado de WhatsApp (el .txt), no un adjunto ni un documento cualquiera. */
export function esChat(archivo: ArchivoMaterial): boolean {
  return archivo.tipo === 'texto' && typeof archivo.texto === 'string' && esChatDeWhatsApp(archivo.texto.slice(0, PRINCIPIO_PARA_DETECTAR))
}

// Cómo nombra WhatsApp un adjunto dentro del chat exportado. iPhone: «<adjunto: NOMBRE>». Android:
// «NOMBRE (archivo adjunto)», después de «Remitente: » o al principio de la línea.
const MARCAS =
  /<(?:adjunto|attached|anexado|anexo|allegato|pièce jointe|Anhang)\s*:\s*([^>\n]+?)\s*>|(?<=: |^)([^\n:<>]+?\.[A-Za-z0-9]{2,5}) \((?:archivo adjunto|file attached|arquivo anexado|fichier joint|allegato|Datei angehängt)\)/gim

function nombresEnChat(texto: string): string[] {
  return Array.from(texto.matchAll(MARCAS), (marca) => (marca[1] ?? marca[2]).trim())
}

/**
 * La conversación de cada archivo, por id. Es el grupo con el que se subió, salvo un caso: un
 * archivo suelto cuyo nombre aparece en exactamente un chat pasa a la conversación de ese chat.
 * En Android el chat exportado suele quedar como archivos sueltos (el .txt, las fotos, los
 * audios): así cada uno vuelve con su chat sin importar en qué orden se subieron, y no puede
 * mezclar porque el nombre lo nombra un solo chat.
 */
export function grupoEfectivo(archivos: ArchivoMaterial[]): Map<string, string | null> {
  const grupos = new Map<string, string | null>(archivos.map((a) => [a.id, a.grupo ?? null]))
  const sueltos = archivos.filter((a) => (a.grupo ?? null) === null && !esChat(a))
  if (!sueltos.length) return grupos

  // Por etapa: el chat del principio y el material son cosas distintas.
  const quienLoNombra = new Map<string, Set<string>>()
  for (const chat of archivos) {
    if (!chat.grupo || !esChat(chat)) continue
    for (const nombre of nombresEnChat(chat.texto ?? '')) {
      const clave = `${chat.etapa}\n${claveDeNombre(nombre)}`
      quienLoNombra.set(clave, (quienLoNombra.get(clave) ?? new Set<string>()).add(chat.grupo))
    }
  }
  for (const suelto of sueltos) {
    const candidatos = quienLoNombra.get(`${suelto.etapa}\n${claveDeNombre(suelto.nombre)}`)
    if (candidatos?.size === 1) grupos.set(suelto.id, [...candidatos][0])
  }
  return grupos
}

export interface Conversacion {
  grupo: string
  chats: ArchivoMaterial[]
  /** Todo lo que no es el chat, en el orden en que se subió. */
  adjuntos: ArchivoMaterial[]
  /** Adjuntos de otra conversación con el mismo chat, que acá faltan: se usan para completar el chat. */
  prestados: ArchivoMaterial[]
  /** Ids de los adjuntos que algún chat de la conversación nombra. */
  nombradosPorChat: Set<string>
  /** Lo que el chat nombra y no está entre lo subido. */
  faltantes: string[]
  /** Si el chat es el mismo (mismos bytes) que el de una conversación anterior: cuál. No se repite. */
  repiteA: string | null
}

/**
 * Las conversaciones de una lista de archivos, en el orden en que apareció el primer archivo de
 * cada una. Pasale los de una sola etapa.
 */
export function conversaciones(archivos: ArchivoMaterial[]): Conversacion[] {
  const efectivo = grupoEfectivo(archivos)
  const porGrupo = new Map<string, Conversacion>()
  for (const archivo of archivos) {
    const grupo = efectivo.get(archivo.id) ?? null
    if (grupo === null) continue
    let conversacion = porGrupo.get(grupo)
    if (!conversacion) {
      conversacion = { grupo, chats: [], adjuntos: [], prestados: [], nombradosPorChat: new Set(), faltantes: [], repiteA: null }
      porGrupo.set(grupo, conversacion)
    }
    if (esChat(archivo)) conversacion.chats.push(archivo)
    else conversacion.adjuntos.push(archivo)
  }
  const lista = [...porGrupo.values()]

  // El .zip y la carpeta de la misma conversación, subidos con nombres distintos: el chat es el
  // mismo byte a byte. Se muestra una sola vez, con los adjuntos de las dos.
  const duenoDelChat = new Map<string, Conversacion>()
  for (const conversacion of lista) {
    const hashes = conversacion.chats.map((chat) => chat.hash).filter((hash): hash is string => Boolean(hash))
    const original = hashes.length && hashes.length === conversacion.chats.length ? duenoDelChat.get(hashes[0]) : undefined
    if (original && hashes.every((hash) => duenoDelChat.get(hash) === original)) {
      conversacion.repiteA = original.grupo
      const yaTiene = new Set([...original.adjuntos, ...original.prestados].map((a) => `${claveDeNombre(a.nombre)}\n${a.hash ?? a.id}`))
      for (const adjunto of conversacion.adjuntos) {
        const clave = `${claveDeNombre(adjunto.nombre)}\n${adjunto.hash ?? adjunto.id}`
        if (!yaTiene.has(clave)) {
          yaTiene.add(clave)
          original.prestados.push(adjunto)
        }
      }
      continue
    }
    for (const hash of hashes) if (!duenoDelChat.has(hash)) duenoDelChat.set(hash, conversacion)
  }

  for (const conversacion of lista) {
    const porClave = indicePorNombre(conversacion)
    const faltantes = new Set<string>()
    for (const chat of conversacion.chats) {
      for (const nombre of nombresEnChat(chat.texto ?? '')) {
        const adjunto = porClave.get(claveDeNombre(nombre))
        if (adjunto) conversacion.nombradosPorChat.add(adjunto.id)
        else faltantes.add(literal(nombre))
      }
    }
    conversacion.faltantes = [...faltantes]
  }
  return lista
}

/** El primero con cada nombre: si hay dos archivos que se llaman igual, el chat nombra al que se subió antes. */
function indicePorNombre(conversacion: Conversacion): Map<string, ArchivoMaterial> {
  const porClave = new Map<string, ArchivoMaterial>()
  for (const adjunto of [...conversacion.adjuntos, ...conversacion.prestados]) {
    const clave = claveDeNombre(adjunto.nombre)
    if (!porClave.has(clave)) porClave.set(clave, adjunto)
  }
  return porClave
}

const ROTULO: Record<TipoMaterial, string> = { imagen: 'Foto', pdf: 'PDF', texto: 'Archivo', audio: 'Audio', video: 'Video', otro: 'Archivo' }
const NO_SE_PUDO: Record<TipoMaterial, string> = {
  imagen: 'no se pudo leer',
  pdf: 'no se pudo leer',
  texto: 'no se pudo leer',
  audio: 'no se pudo escuchar',
  video: 'no se pudo ver',
  otro: 'no se puede leer este tipo de archivo',
}
const TODAVIA_NO: Record<TipoMaterial, string> = {
  imagen: 'todavía no se leyó',
  pdf: 'todavía no se leyó',
  texto: 'todavía no se leyó',
  audio: 'todavía no se escuchó',
  video: 'todavía no se vio',
  otro: 'todavía no se leyó',
}
const AUTOMATICO: Partial<Record<TipoMaterial, string>> = {
  audio: 'transcripción automática',
  video: 'descripción y transcripción automáticas',
}

function esSticker(archivo: ArchivoMaterial): boolean {
  return archivo.tipo === 'imagen' && /-STICKER-/i.test(archivo.nombre)
}

/** m:ss, o h:mm:ss desde una hora. */
export function duracionLegible(segundos: number): string {
  const total = Math.max(0, Math.round(segundos))
  const dos = (n: number) => String(n).padStart(2, '0')
  const horas = Math.floor(total / 3600)
  const minutos = Math.floor((total % 3600) / 60)
  return horas ? `${horas}:${dos(minutos)}:${dos(total % 60)}` : `${minutos}:${dos(total % 60)}`
}

/** «Audio «N», 0:13, transcripción automática»: lo que va antes del contenido de un audio o un video. */
function rotuloAutomatico(archivo: ArchivoMaterial, conNombre: boolean): string {
  const partes = [conNombre ? `${ROTULO[archivo.tipo]} «${literal(archivo.nombre)}»` : ROTULO[archivo.tipo]]
  if (archivo.duracion !== undefined) partes.push(duracionLegible(archivo.duracion))
  partes.push(`${AUTOMATICO[archivo.tipo]}${archivo.dudosa ? ', puede tener errores' : ''}`)
  return partes.join(', ')
}

/**
 * Lo que dice un archivo, o '' si no se leyó nada. Lo que copió Claude de una foto o de un PDF es
 * letra del dueño; lo que describió, no, y va entre ⟪ y ⟫. `tope` recorta el texto de un
 * documento largo cuando el material no entra entero.
 */
function cuerpoDe(archivo: ArchivoMaterial, tope?: number): string {
  if (archivo.tipo === 'audio' || archivo.tipo === 'video') return archivo.texto ? automatico(archivo.texto) : ''
  let escrito = literal(archivo.texto ?? '')
  if (tope !== undefined && escrito.length > tope) {
    const corte = escrito.lastIndexOf('\n', tope)
    const dejado = escrito.slice(0, corte > tope / 2 ? corte : tope)
    escrito = `${dejado}\n[Se recortó este archivo: tenía ${escrito.length.toLocaleString('es-AR')} caracteres y se dejaron los primeros ${dejado.length.toLocaleString('es-AR')}.]`
  }
  const descripto = archivo.descripcion ? automatico(archivo.descripcion) : ''
  return [escrito, descripto].filter(Boolean).join(escrito.includes('\n') ? '\n' : ' ')
}

/** Un archivo metido en una línea del chat: «[Foto «N»: …]». */
function marcador(archivo: ArchivoMaterial, tope?: number): string {
  const nombre = `${ROTULO[archivo.tipo]} «${literal(archivo.nombre)}»`
  if (esSticker(archivo)) return `[Sticker «${literal(archivo.nombre)}»]`
  if (archivo.texto === null) return `[${nombre}: ${TODAVIA_NO[archivo.tipo]}]`
  if (archivo.tipo === 'otro') return `[${nombre}: ${NO_SE_PUDO.otro}]`
  const cuerpo = cuerpoDe(archivo, tope)
  if (!cuerpo) return archivo.problema ? `[${nombre}: ${NO_SE_PUDO[archivo.tipo]}]` : `[${nombre}]`
  if (AUTOMATICO[archivo.tipo]) return `[${rotuloAutomatico(archivo, true)}: ${cuerpo}]`
  return `[${nombre}: ${cuerpo}]`
}

/** Un archivo como bloque propio, debajo de un encabezado con su nombre. */
function bloque(archivo: ArchivoMaterial, tope?: number): string {
  const cuerpo = cuerpoDe(archivo, tope)
  if (!cuerpo || archivo.texto === null || esSticker(archivo)) return marcador(archivo, tope)
  return AUTOMATICO[archivo.tipo] ? `${rotuloAutomatico(archivo, false)}: ${cuerpo}` : cuerpo
}

function cantidad(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`
}

function sinLeer(archivo: ArchivoMaterial): boolean {
  return archivo.texto === null || (archivo.texto === '' && Boolean(archivo.problema) && archivo.tipo !== 'otro')
}

/** «(9 archivos: el chat, 3 audios, 2 fotos, 1 PDF, 1 video, 1 sin leer)». */
function resumenDeConversacion(conversacion: Conversacion): string {
  const adjuntos = [...conversacion.adjuntos, ...conversacion.prestados]
  const contar = (filtro: (a: ArchivoMaterial) => boolean) => adjuntos.filter(filtro).length
  const partes: string[] = []
  if (conversacion.chats.length) partes.push(conversacion.chats.length === 1 ? 'el chat' : `${conversacion.chats.length} chats`)
  const tipos: [number, string, string][] = [
    [contar((a) => a.tipo === 'audio'), 'audio', 'audios'],
    [contar((a) => a.tipo === 'imagen' && !esSticker(a)), 'foto', 'fotos'],
    [contar((a) => a.tipo === 'pdf'), 'PDF', 'PDF'],
    [contar((a) => a.tipo === 'video'), 'video', 'videos'],
    [contar((a) => a.tipo === 'texto'), 'archivo de texto', 'archivos de texto'],
    [contar(esSticker), 'sticker', 'stickers'],
    [contar((a) => a.tipo === 'otro'), 'archivo de otro tipo', 'archivos de otro tipo'],
    [contar(sinLeer), 'sin leer', 'sin leer'],
  ]
  for (const [n, uno, varios] of tipos) if (n) partes.push(cantidad(n, uno, varios))
  if (conversacion.chats.length) {
    const sinNombrar = adjuntos.filter((a) => !conversacion.nombradosPorChat.has(a.id)).length
    if (sinNombrar) partes.push(`${sinNombrar} que el chat no nombra`)
  }
  const total = conversacion.chats.length + adjuntos.length
  return `(${cantidad(total, 'archivo', 'archivos')}: ${partes.join(', ')})`
}

function seccionDeConversacion(conversacion: Conversacion, topes: Map<string, number>): string {
  const partes = [`## Conversación: ${literal(conversacion.grupo)}`]
  if (conversacion.repiteA) {
    partes[0] += `\n(es la misma conversación que «${literal(conversacion.repiteA)}»: el chat es el mismo y no se repite)`
    return partes[0]
  }
  partes[0] += `\n${resumenDeConversacion(conversacion)}`
  const adjuntos = [...conversacion.adjuntos, ...conversacion.prestados]

  if (!conversacion.chats.length) {
    // Capturas subidas a mano o fotos de un catálogo: no hay chat que diga dónde va cada una.
    for (const adjunto of adjuntos) partes.push(`### ${literal(adjunto.nombre)}\n${bloque(adjunto, topes.get(adjunto.id))}`)
    return partes.join('\n\n')
  }

  const porClave = indicePorNombre(conversacion)
  const enSuLugar = new Set<string>()
  for (const chat of conversacion.chats) {
    // Primero se limpia lo que escribió la gente y después se insertan los adjuntos: así los
    // únicos ⟪⟫ que quedan son los que pone la app.
    const texto = literal(chat.texto ?? '').replace(MARCAS, (_marca, deIphone: string | undefined, deAndroid: string | undefined) => {
      const nombre = (deIphone ?? deAndroid ?? '').trim()
      const adjunto = porClave.get(claveDeNombre(nombre))
      if (!adjunto) return `[Adjunto «${literal(nombre)}»: no está entre lo que subiste]`
      const insertado = marcador(adjunto, topes.get(adjunto.id))
      if (insertado.length > LARGO_EN_LINEA) {
        return `[${ROTULO[adjunto.tipo]} «${literal(adjunto.nombre)}»: es largo; está completo más abajo, en «Otros archivos de esta conversación»]`
      }
      enSuLugar.add(adjunto.id)
      return insertado
    })
    partes.push(`### Chat: ${literal(chat.nombre)}\n${texto}`)
  }

  // Lo que ningún chat nombra y lo que era largo para ir en medio del chat.
  const abajo = adjuntos.filter((adjunto) => !enSuLugar.has(adjunto.id))
  if (abajo.length) {
    partes.push('### Otros archivos de esta conversación')
    for (const adjunto of abajo) partes.push(`#### ${literal(adjunto.nombre)}\n${bloque(adjunto, topes.get(adjunto.id))}`)
  }
  return partes.join('\n\n')
}

/** Las partes del texto de una lista de archivos: primero los sueltos, después cada conversación. */
function partesDeArchivos(archivos: ArchivoMaterial[], topes: Map<string, number>): { partes: string[]; hayConversaciones: boolean } {
  const lista = conversaciones(archivos)
  const efectivo = grupoEfectivo(archivos)
  const partes: string[] = []
  // Un suelto sin nada leído no aporta: se omite, como siempre.
  const sueltos = archivos.filter((a) => (efectivo.get(a.id) ?? null) === null && cuerpoDe(a) !== '')
  if (sueltos.length) {
    if (lista.length) partes.push('## Archivos sueltos')
    for (const suelto of sueltos) partes.push(`### ${literal(suelto.nombre)}\n${bloque(suelto, topes.get(suelto.id))}`)
  }
  for (const conversacion of lista) partes.push(seccionDeConversacion(conversacion, topes))
  return { partes, hayConversaciones: lista.length > 0 }
}

/**
 * El texto de una lista de archivos, separado por conversación. Con esto se arma el chat del
 * principio (lo que se sube en `pedido_chat`) y el material.
 */
export function textoDeArchivos(archivos: ArchivoMaterial[]): string {
  return partesDeArchivos(archivos, new Map()).partes.join('\n\n')
}

function armar(estado: EstadoCuestionario, topes: Map<string, number>): string {
  const partes: string[] = []
  // `estado.chat` ya viene armado con textoDeArchivos y trae sus ⟪⟫: no se toca.
  if (estado.chat) partes.push(`### Chat del principio\n${estado.chat}`)
  const deMaterial = estado.material.archivos.filter((a) => a.etapa === 'material')
  const archivos = partesDeArchivos(deMaterial, topes)
  partes.push(...archivos.partes)
  if (estado.material.textos.length) {
    if (archivos.hayConversaciones) partes.push('## Textos pegados')
    estado.material.textos.forEach((t, i) => partes.push(`### Texto pegado ${i + 1}\n${literal(t.texto)}`))
  }
  return partes.join('\n\n')
}

interface MaterialArmado {
  texto: string
  /** Qué se recortó para entrar en el límite, para el reporte. Vacío si entró entero. */
  recortes: string[]
}

/**
 * El material entero o, si pasa el límite, recortado. Primero se acortan los documentos largos
 * que no son chats, todos en la misma proporción y con una nota en cada uno: cortar por el final
 * dejaría afuera las últimas conversaciones y los textos pegados, que son lo que más importa.
 */
function armarConLimite(estado: EstadoCuestionario): MaterialArmado {
  const entero = armar(estado, new Map())
  if (entero.length <= LIMITE_CARACTERES_MATERIAL) return { texto: entero, recortes: [] }

  const recortes: string[] = []
  const topes = new Map<string, number>()
  const documentos = estado.material.archivos.filter(
    (a) => a.etapa === 'material' && a.tipo !== 'audio' && a.tipo !== 'video' && !esChat(a) && (a.texto?.length ?? 0) > LARGO_PARA_RECORTAR,
  )
  const largoTotal = documentos.reduce((suma, a) => suma + (a.texto?.length ?? 0), 0)
  // El margen cubre las notas de recorte que se agregan.
  const exceso = entero.length - LIMITE_CARACTERES_MATERIAL + 200 * (documentos.length + 1)
  if (largoTotal > 0) {
    const proporcion = Math.max(0, (largoTotal - exceso) / largoTotal)
    for (const documento of documentos) {
      const largo = documento.texto?.length ?? 0
      const tope = Math.max(MINIMO_AL_RECORTAR, Math.floor(largo * proporcion))
      if (tope >= largo) continue
      topes.set(documento.id, tope)
      recortes.push(`«${documento.nombre}» (de ${largo.toLocaleString('es-AR')} a unos ${tope.toLocaleString('es-AR')} caracteres)`)
    }
  }

  let texto = armar(estado, topes)
  if (texto.length > LIMITE_CARACTERES_MATERIAL) {
    const total = texto.length
    const corte = texto.lastIndexOf('\n', LIMITE_CARACTERES_MATERIAL)
    texto = texto.slice(0, corte > 0 ? corte : LIMITE_CARACTERES_MATERIAL)
    // Un corte en medio de una transcripción la dejaría abierta, y lo que sigue pasaría por texto del dueño.
    if (texto.lastIndexOf('⟪') > texto.lastIndexOf('⟫')) texto += '…⟫'
    texto += `\n\n[Se recortó el material: tenía ${total.toLocaleString('es-AR')} caracteres y se dejaron los primeros ${LIMITE_CARACTERES_MATERIAL.toLocaleString('es-AR')}.]`
    recortes.push(`el final del material (tenía ${total.toLocaleString('es-AR')} caracteres y quedaron los primeros ${LIMITE_CARACTERES_MATERIAL.toLocaleString('es-AR')})`)
  }
  return { texto, recortes }
}

/**
 * Todo el material, en un orden que solo depende del estado (así la caché de Claude no se rompe):
 * el chat del principio, los archivos sueltos, una sección por conversación y los textos pegados.
 */
export function armarTextoDelMaterial(estado: EstadoCuestionario): string {
  return armarConLimite(estado).texto
}

/** Qué quedó afuera por el límite de tamaño, o null si el material entró entero. Va al reporte. */
export function recorteDelMaterial(estado: EstadoCuestionario): string | null {
  const { recortes } = armarConLimite(estado)
  return recortes.length ? recortes.join('; ') : null
}

export interface IndiceDeMaterial {
  /** Dónde se mandó un adjunto: su conversación y las líneas del chat que lo nombran. null si va suelto. */
  contexto(archivo: ArchivoMaterial): ContextoAdjunto | null
  /** Un adjunto de una conversación que tiene chat: si no se puede leer, se avisa y se sigue. */
  esAdjunto(archivo: ArchivoMaterial): boolean
}

/** Para preguntar lo mismo por muchos archivos sin recorrer los chats cada vez. */
export function indiceDeMaterial(archivos: ArchivoMaterial[]): IndiceDeMaterial {
  const porEtapa = new Map<string, { efectivo: Map<string, string | null>; porGrupo: Map<string, Conversacion> }>()
  const deEtapa = (etapa: ArchivoMaterial['etapa']) => {
    let datos = porEtapa.get(etapa)
    if (!datos) {
      const lista = archivos.filter((a) => a.etapa === etapa)
      datos = { efectivo: grupoEfectivo(lista), porGrupo: new Map(conversaciones(lista).map((c) => [c.grupo, c])) }
      porEtapa.set(etapa, datos)
    }
    return datos
  }
  const lineasPorChat = new Map<string, { lineas: string[]; donde: Map<string, number> }>()
  const lineasDe = (chat: ArchivoMaterial) => {
    let indice = lineasPorChat.get(chat.id)
    if (!indice) {
      const lineas = (chat.texto ?? '').split('\n')
      const donde = new Map<string, number>()
      lineas.forEach((linea, i) => {
        for (const nombre of nombresEnChat(linea)) {
          const clave = claveDeNombre(nombre)
          if (!donde.has(clave)) donde.set(clave, i)
        }
      })
      indice = { lineas, donde }
      lineasPorChat.set(chat.id, indice)
    }
    return indice
  }

  const conversacionDe = (archivo: ArchivoMaterial): Conversacion | null => {
    const { efectivo, porGrupo } = deEtapa(archivo.etapa)
    const grupo = efectivo.get(archivo.id) ?? null
    return grupo === null ? null : (porGrupo.get(grupo) ?? null)
  }

  return {
    contexto(archivo) {
      const conversacion = conversacionDe(archivo)
      if (!conversacion) return null
      const clave = claveDeNombre(archivo.nombre)
      for (const chat of conversacion.chats) {
        const { lineas, donde } = lineasDe(chat)
        const i = donde.get(clave)
        if (i === undefined) continue
        // La línea que lo nombra y las dos de antes: alcanza para saber de qué se estaba hablando.
        return { conversacion: conversacion.grupo, lineas: literal(lineas.slice(Math.max(0, i - 2), i + 1).join('\n')).slice(-1_200) }
      }
      return { conversacion: conversacion.grupo, lineas: '' }
    },
    esAdjunto(archivo) {
      const conversacion = conversacionDe(archivo)
      return Boolean(conversacion && conversacion.chats.length && !conversacion.chats.some((chat) => chat.id === archivo.id))
    },
  }
}

export function contextoDeAdjunto(archivos: ArchivoMaterial[], archivo: ArchivoMaterial): ContextoAdjunto | null {
  return indiceDeMaterial(archivos).contexto(archivo)
}

export function esAdjuntoDeConversacion(archivos: ArchivoMaterial[], archivo: ArchivoMaterial): boolean {
  return indiceDeMaterial(archivos).esAdjunto(archivo)
}

export interface ResumenDeMaterial {
  conversaciones: number
  sueltos: number
  /** Markdown para la sección «## Material» de cierre.md. */
  lineas: string[]
}

function segundosDe(archivos: ArchivoMaterial[], tipo: TipoMaterial): number {
  return archivos.filter((a) => a.tipo === tipo).reduce((suma, a) => suma + (a.duracion ?? 0), 0)
}

/** Lo que Mateo necesita saber de lo que subió el dueño: qué hay en cada conversación y qué faltó. */
export function resumenDeMaterial(estado: EstadoCuestionario): ResumenDeMaterial {
  const archivos = estado.material.archivos.filter((a) => a.etapa === 'material')
  const lista = conversaciones(archivos)
  const efectivo = grupoEfectivo(archivos)
  const sueltos = archivos.filter((a) => (efectivo.get(a.id) ?? null) === null)
  const lineas: string[] = []

  const conProblema = (a: ArchivoMaterial) => `«${a.nombre}» (${a.texto === null ? TODAVIA_NO[a.tipo] : (a.problema ?? NO_SE_PUDO[a.tipo])})`

  for (const conversacion of lista) {
    lineas.push(`### ${conversacion.grupo}`, '')
    if (conversacion.repiteA) {
      lineas.push(`- Es la misma conversación que «${conversacion.repiteA}»: el chat es idéntico y a Claude se le mandó una sola vez.`, '')
      continue
    }
    const adjuntos = conversacion.adjuntos
    const contar = (tipo: TipoMaterial) => adjuntos.filter((a) => a.tipo === tipo && !esSticker(a)).length
    lineas.push(`- Chat: ${conversacion.chats.length ? `sí (${conversacion.chats.map((chat) => `«${chat.nombre}»`).join(', ')})` : 'no'}`)
    const cantidades: string[] = []
    const audios = contar('audio')
    const videos = contar('video')
    if (audios) cantidades.push(`${cantidad(audios, 'audio', 'audios')} (${duracionLegible(segundosDe(adjuntos, 'audio'))} min)`)
    if (videos) cantidades.push(`${cantidad(videos, 'video', 'videos')} (${duracionLegible(segundosDe(adjuntos, 'video'))} min)`)
    if (contar('imagen')) cantidades.push(cantidad(contar('imagen'), 'foto', 'fotos'))
    if (contar('pdf')) cantidades.push(`${contar('pdf')} PDF`)
    if (contar('texto')) cantidades.push(cantidad(contar('texto'), 'archivo de texto', 'archivos de texto'))
    if (contar('otro')) cantidades.push(cantidad(contar('otro'), 'archivo de otro tipo', 'archivos de otro tipo'))
    const stickers = adjuntos.filter(esSticker).length
    if (stickers) cantidades.push(cantidad(stickers, 'sticker', 'stickers'))
    lineas.push(`- Adjuntos: ${cantidades.length ? cantidades.join(', ') : 'ninguno'}`)
    if (conversacion.prestados.length) {
      lineas.push(`- Se completó con ${cantidad(conversacion.prestados.length, 'archivo', 'archivos')} de otra conversación con el mismo chat.`)
    }
    const dudosas = adjuntos.filter((a) => a.dudosa)
    if (dudosas.length) lineas.push(`- Transcripciones dudosas (conviene escucharlas): ${dudosas.map((a) => `«${a.nombre}»`).join(', ')}`)
    const ilegibles = [...conversacion.chats, ...adjuntos].filter((a) => a.texto === null || a.problema)
    if (ilegibles.length) lineas.push(`- No se pudo leer: ${ilegibles.map(conProblema).join('; ')}`)
    if (conversacion.faltantes.length) {
      lineas.push(`- El chat nombra y no se subió: ${conversacion.faltantes.map((nombre) => `«${nombre}»`).join(', ')}`)
    }
    lineas.push('')
  }

  if (sueltos.length) {
    lineas.push('### Archivos sueltos', '')
    for (const suelto of sueltos) {
      const detalle = suelto.texto === null || suelto.problema ? `: ${suelto.texto === null ? TODAVIA_NO[suelto.tipo] : suelto.problema}` : ''
      lineas.push(`- «${suelto.nombre}» (${ROTULO[suelto.tipo].toLowerCase()}${esChat(suelto) ? ', es un chat' : ''})${detalle}`)
    }
    lineas.push('')
  }
  if (!lineas.length) lineas.push('No subió archivos.', '')
  return { conversaciones: lista.length, sueltos: sueltos.length, lineas }
}
