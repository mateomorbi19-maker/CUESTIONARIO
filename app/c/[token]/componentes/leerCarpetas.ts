import { esArchivoDeSistema, esChatDeWhatsApp, gruposDeRutas } from '@/lib/grupos'
import { LIMITE_ARCHIVOS } from '@/lib/limites'

/**
 * De lo que la persona elige o suelta, a una lista de archivos con su conversación. Solo corre
 * en el navegador: usa las API de carpetas de los selectores y del arrastre.
 */

export interface ArchivoConRuta {
  archivo: File
  /** Con las carpetas de arriba, si las hay: «1 - Venta/Audios/a.opus». Solo sirve para agrupar. */
  ruta: string
}

export interface ArchivoParaSubir {
  archivo: File
  /** null: suelto, o un .zip que arma su propia conversación con su nombre. */
  grupo: string | null
  /** La persona eligió o escribió esa conversación. false: salió de la carpeta. */
  grupoElegido: boolean
  /** Es el chat exportado: se sube primero, así la conversación aparece con su chat. */
  esChat: boolean
}

export function esZip(nombre: string): boolean {
  return /\.zip$/i.test(nombre)
}

// Cómo nombra WhatsApp lo que exporta: Android («IMG-20260902-WA0007.jpg», «PTT-…opus»), iPhone
// («00000043-AUDIO-2026-09-02-18-41-12.opus») y la versión de escritorio («WhatsApp Image 2026-…»).
const NOMBRE_DE_WHATSAPP =
  /^(?:(?:IMG|VID|PTT|AUD|STK|DOC)-\d{8}-WA\d+|\d{6,}-(?:AUDIO|PHOTO|VIDEO|STICKER|GIF|PTT)-|WhatsApp (?:Image|Video|Audio|Ptt|Chat) )/i

/** ¿Parece salido de un chat de WhatsApp? Un suelto así casi seguro es de una conversación. */
export function pareceDeWhatsApp(nombre: string, esChat: boolean): boolean {
  return esChat || /\.opus$/i.test(nombre) || NOMBRE_DE_WHATSAPP.test(nombre)
}

/** Lo elegido con un selector. Con «Elegir carpeta», cada archivo trae su ruta desde esa carpeta. */
export function archivosDelSelector(archivos: FileList | null): ArchivoConRuta[] {
  return Array.from(archivos ?? [], (archivo) => ({ archivo, ruta: archivo.webkitRelativePath || archivo.name }))
}

/**
 * Lo que se soltó en la zona, recorriendo las carpetas.
 *
 * No es `async` a propósito: las entradas hay que pedirlas todas antes de que termine el evento,
 * porque después el navegador vacía la lista. Recién con todas en la mano se empieza a leer.
 */
export function archivosSoltados(datos: DataTransfer): Promise<ArchivoConRuta[]> {
  const items = Array.from(datos.items ?? [])
  if (!items.some((item) => typeof item.webkitGetAsEntry === 'function')) {
    // Sin la API de carpetas solo llegan archivos sueltos.
    return Promise.resolve(archivosDelSelector(datos.files))
  }
  const entradas: FileSystemEntry[] = []
  const sueltos: File[] = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entrada = item.webkitGetAsEntry()
    if (entrada) {
      entradas.push(entrada)
      continue
    }
    const archivo = item.getAsFile()
    if (archivo) sueltos.push(archivo)
  }
  return recorrer(entradas, sueltos)
}

async function recorrer(entradas: FileSystemEntry[], sueltos: File[]): Promise<ArchivoConRuta[]> {
  const lista: ArchivoConRuta[] = sueltos.map((archivo) => ({ archivo, ruta: archivo.name }))
  const vistas = new Map<string, number>()
  for (const entrada of entradas) {
    let raiz = entrada.name
    if (entrada.isDirectory) {
      // Dos carpetas con el mismo nombre arrastradas desde lugares distintos llegan con la misma
      // ruta y quedarían como una sola conversación. La segunda se agrupa como «Nombre (2)».
      const veces = (vistas.get(entrada.name) ?? 0) + 1
      vistas.set(entrada.name, veces)
      if (veces > 1) raiz = `${entrada.name} (${veces})`
    }
    await agregar(entrada, raiz, lista)
  }
  return lista
}

async function agregar(entrada: FileSystemEntry, ruta: string, lista: ArchivoConRuta[]): Promise<void> {
  // Pasado el máximo no se sube nada: seguir recorriendo una carpeta enorme (todo «Documentos»,
  // por error) solo haría esperar para terminar en el mismo aviso.
  if (lista.length > LIMITE_ARCHIVOS || esArchivoDeSistema(ruta)) return
  if (entrada.isFile) {
    lista.push({ archivo: await archivoDe(entrada as FileSystemFileEntry), ruta })
    return
  }
  if (!entrada.isDirectory) return
  const lector = (entrada as FileSystemDirectoryEntry).createReader()
  // readEntries devuelve de a tandas (de a 100 en Chrome): hay que llamarlo hasta que venga vacío.
  for (;;) {
    const tanda = await new Promise<FileSystemEntry[]>((listo, falla) => lector.readEntries(listo, falla))
    if (tanda.length === 0) return
    for (const hija of tanda) await agregar(hija, `${ruta}/${hija.name}`, lista)
  }
}

function archivoDe(entrada: FileSystemFileEntry): Promise<File> {
  return new Promise((listo, falla) => entrada.file(listo, falla))
}

/** Los primeros 4 KB alcanzan para saber si un .txt es un chat exportado o unas notas cualquiera. */
async function esChatExportado(archivo: File): Promise<boolean> {
  if (!/\.txt$/i.test(archivo.name)) return false
  try {
    return esChatDeWhatsApp(await archivo.slice(0, 4096).text())
  } catch {
    // No se pudo leer ahora: que decida el servidor cuando llegue.
    return false
  }
}

/**
 * La conversación de cada archivo según su carpeta. Saca lo que dejan Mac y Windows (.DS_Store,
 * Thumbs.db). Lo que no queda en ninguna conversación va a `grupoPorDefecto`.
 */
export async function conGrupos(
  lista: ArchivoConRuta[],
  grupoPorDefecto: string | null,
): Promise<ArchivoParaSubir[]> {
  const utiles = lista.filter(({ ruta }) => !esArchivoDeSistema(ruta))
  const chats = await Promise.all(utiles.map(({ archivo }) => esChatExportado(archivo)))
  const grupos = gruposDeRutas(
    utiles.map(({ ruta }) => ruta),
    chats,
  )
  const hayChats = chats.some(Boolean)
  return utiles.map(({ archivo }, i) => {
    // Un .zip lleva el nombre de su carpeta solo si esa carpeta es una conversación (tiene un chat
    // adentro). Si no, va sin grupo y el servidor le pone el suyo: varios .zip juntos en una
    // carpeta son varias conversaciones, no una con el nombre de la carpeta.
    const deducido = esZip(archivo.name) && !hayChats ? null : grupos[i]
    if (deducido !== null) return { archivo, grupo: deducido, grupoElegido: false, esChat: chats[i] }
    return { archivo, grupo: grupoPorDefecto, grupoElegido: grupoPorDefecto !== null, esChat: chats[i] }
  })
}
