import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCuestionario } from './cuestionarios'
import type { DetalleSubida } from './estado-publico'

/**
 * Las subidas por partes, en el disco.
 *
 * Un archivo grande no puede viajar en un solo pedido: el proxy de Easypanel corta cualquier
 * cuerpo que tarde más de 60 segundos en llegar, y con mala señal 10 MB tardan más que eso. Acá
 * cada subida es un archivo `<id>.parte` que crece parte por parte, y un `<id>.json` que dice de
 * qué archivo es. Recibir la misma parte dos veces no rompe nada, así que reintentar es seguro.
 *
 * No hay tabla en la base: una subida a medias no es parte del cuestionario hasta que termina.
 */

export interface Subida {
  id: string
  nombre: string
  /** El tamaño que declaró el navegador. La subida termina cuando llegaron todos. */
  bytes: number
  grupo: string | null
  /** La conversación la eligió la persona (no se dedujo de una carpeta). */
  grupoElegido: boolean
  /** Milisegundos desde 1970. */
  creada: number
  terminada: boolean
  /** Lo que devolvió «terminar», para repetirlo igual si se pide de nuevo. */
  resultado: DetalleSubida | null
}

export const MAXIMO_SUBIDAS_ABIERTAS = 6
const HORAS_DE_VIDA = 24
// Una subida sin partes nuevas en este tiempo está abandonada: no puede seguir ocupando cupo ni
// espacio del cuestionario hasta que se borre al día siguiente.
const HORAS_SIN_ACTIVIDAD = 2
const HORA = 60 * 60_000
const ID_VALIDO = /^[0-9a-f-]{36}$/

function raizDeSubidas(): string {
  // turbopackIgnore: sin esto el build copia la carpeta data entera (archivos de clientes, modelos) a la imagen.
  // Solo en el join de adentro: si también se ignora el de afuera, el build deja de saber que todo
  // cuelga de «subidas» y se lleva cada .json del proyecto.
  return join(process.env.DIR_DATOS ?? join(/*turbopackIgnore: true*/ process.cwd(), 'data'), 'subidas')
}

export function carpetaSubidas(cuestionarioId: string): string {
  return join(raizDeSubidas(), cuestionarioId)
}

export function rutaDeParte(cuestionarioId: string, id: string): string {
  return join(carpetaSubidas(cuestionarioId), `${id}.parte`)
}

function rutaDeDatos(cuestionarioId: string, id: string): string {
  return join(carpetaSubidas(cuestionarioId), `${id}.json`)
}

/** Un lugar donde dejar un archivo que llegó entero en un pedido, hasta incorporarlo. Se limpia como las subidas. */
export async function rutaTemporal(cuestionarioId: string): Promise<string> {
  // El volumen de producción ya tiene datos y no trae esta carpeta: se crea antes de escribir.
  await mkdir(carpetaSubidas(cuestionarioId), { recursive: true })
  return join(carpetaSubidas(cuestionarioId), `${randomUUID()}.entero`)
}

/** 410 y no 404: con un 404 la pantalla daría por inválido el link del cuestionario. */
function subidaVencida(): ErrorCuestionario {
  return new ErrorCuestionario('Esa subida venció o ya no existe. Volvé a subir el archivo.', 410, 'subida_vencida')
}

export async function leerSubida(cuestionarioId: string, id: string): Promise<Subida> {
  // El id llega en la URL: sin este control se podría leer cualquier .json del servidor.
  if (!ID_VALIDO.test(id)) throw subidaVencida()
  try {
    return JSON.parse(await readFile(rutaDeDatos(cuestionarioId, id), 'utf8')) as Subida
  } catch {
    throw subidaVencida()
  }
}

async function guardar(cuestionarioId: string, subida: Subida): Promise<void> {
  // Primero a un temporal: si el servidor se corta a mitad de la escritura, no queda un .json a medias.
  const destino = rutaDeDatos(cuestionarioId, subida.id)
  await writeFile(`${destino}.tmp`, JSON.stringify(subida))
  await rename(`${destino}.tmp`, destino)
}

async function listar(cuestionarioId: string): Promise<Subida[]> {
  let nombres: string[]
  try {
    nombres = await readdir(carpetaSubidas(cuestionarioId))
  } catch {
    return []
  }
  const subidas: Subida[] = []
  for (const nombre of nombres) {
    if (!nombre.endsWith('.json')) continue
    const subida = await leerSubida(cuestionarioId, nombre.slice(0, -5)).catch(() => null)
    if (subida) subidas.push(subida)
  }
  return subidas
}

async function borrar(cuestionarioId: string, id: string): Promise<void> {
  await Promise.all([rm(rutaDeParte(cuestionarioId, id), { force: true }), rm(rutaDeDatos(cuestionarioId, id), { force: true })])
}

/** Cuánto llegó de una subida. 0 si el archivo de partes no está. */
export async function bytesRecibidos(cuestionarioId: string, id: string): Promise<number> {
  try {
    return (await stat(rutaDeParte(cuestionarioId, id))).size
  } catch {
    return 0
  }
}

/** Cuándo llegó la última parte. */
async function ultimaActividad(cuestionarioId: string, subida: Subida): Promise<number> {
  try {
    return Math.max(subida.creada, (await stat(rutaDeParte(cuestionarioId, subida.id))).mtimeMs)
  } catch {
    return subida.creada
  }
}

/** Las que siguen recibiendo partes. Las abandonadas no cuentan para ningún límite. */
async function abiertasEnUso(cuestionarioId: string): Promise<Subida[]> {
  const ahora = Date.now()
  const enUso: Subida[] = []
  for (const subida of await listar(cuestionarioId)) {
    if (subida.terminada) continue
    if (ahora - (await ultimaActividad(cuestionarioId, subida)) < HORAS_SIN_ACTIVIDAD * HORA) enUso.push(subida)
  }
  return enUso
}

/** Lo que declaran las subidas en curso: cuenta contra el espacio del cuestionario antes de que lleguen. */
export async function bytesAbiertos(cuestionarioId: string): Promise<number> {
  return (await abiertasEnUso(cuestionarioId)).reduce((suma, subida) => suma + subida.bytes, 0)
}

/**
 * La subida abierta de ese mismo archivo (mismo nombre, tamaño y conversación), si hay una. Así,
 * después de recargar la página o de que el celular mate la pestaña, elegir el archivo de nuevo
 * sigue desde donde quedó en vez de empezar de cero.
 */
export async function subidaAbierta(
  cuestionarioId: string,
  datos: Pick<Subida, 'nombre' | 'bytes' | 'grupo' | 'grupoElegido'>,
): Promise<Subida | null> {
  const ahora = Date.now()
  for (const subida of await listar(cuestionarioId)) {
    if (subida.terminada || ahora - subida.creada >= HORAS_DE_VIDA * HORA) continue
    if (
      subida.nombre === datos.nombre &&
      subida.bytes === datos.bytes &&
      subida.grupo === datos.grupo &&
      subida.grupoElegido === datos.grupoElegido
    ) {
      return subida
    }
  }
  return null
}

export async function crearSubida(
  cuestionarioId: string,
  datos: Pick<Subida, 'nombre' | 'bytes' | 'grupo' | 'grupoElegido'>,
): Promise<Subida> {
  const carpeta = carpetaSubidas(cuestionarioId)
  await mkdir(carpeta, { recursive: true })
  const ahora = Date.now()
  for (const vieja of await listar(cuestionarioId)) {
    if (ahora - vieja.creada >= HORAS_DE_VIDA * HORA) await borrar(cuestionarioId, vieja.id)
  }
  if ((await abiertasEnUso(cuestionarioId)).length >= MAXIMO_SUBIDAS_ABIERTAS) {
    throw new ErrorCuestionario('Hay demasiadas subidas a medias. Esperá a que terminen y probá de nuevo.', 429)
  }
  const subida: Subida = { id: randomUUID(), ...datos, creada: ahora, terminada: false, resultado: null }
  await writeFile(rutaDeParte(cuestionarioId, subida.id), '')
  await guardar(cuestionarioId, subida)
  return subida
}

/**
 * Escribe una parte en su lugar y devuelve cuántos bytes hay. Mandar dos veces la misma parte da
 * el mismo resultado. Si `desde` deja un hueco, avisa desde dónde hay que seguir.
 */
export async function recibirParte(cuestionarioId: string, id: string, desde: number, datos: Buffer): Promise<number> {
  const subida = await leerSubida(cuestionarioId, id)
  if (subida.terminada) return subida.bytes
  const ruta = rutaDeParte(cuestionarioId, id)
  let recibidos: number
  try {
    recibidos = (await stat(ruta)).size
  } catch {
    throw subidaVencida()
  }
  if (desde > recibidos) {
    throw new ErrorCuestionario('Falta una parte anterior del archivo. La subida sigue desde donde quedó.', 409, 'faltan_bytes', { recibidos })
  }
  if (desde + datos.length > subida.bytes) {
    throw new ErrorCuestionario('Llegó más de lo que mide el archivo. Volvé a elegirlo y subilo de nuevo.', 400)
  }
  const archivo = await open(ruta, 'r+')
  try {
    let escritos = 0
    while (escritos < datos.length) {
      escritos += (await archivo.write(datos, escritos, datos.length - escritos, desde + escritos)).bytesWritten
    }
  } finally {
    await archivo.close()
  }
  return Math.max(recibidos, desde + datos.length)
}

/** Deja anotado el resultado y borra las partes, si siguen ahí. */
export async function marcarTerminada(cuestionarioId: string, id: string, resultado: DetalleSubida): Promise<void> {
  const subida = await leerSubida(cuestionarioId, id)
  await guardar(cuestionarioId, { ...subida, terminada: true, resultado })
  await rm(rutaDeParte(cuestionarioId, id), { force: true })
}

/** Cancelarla borra lo recibido. Si ya no existe, no pasa nada: el resultado que se busca es el mismo. */
export async function cancelarSubida(cuestionarioId: string, id: string): Promise<void> {
  if (!ID_VALIDO.test(id)) return
  await borrar(cuestionarioId, id)
}

/**
 * Al renombrar una conversación, las subidas que todavía no terminaron tienen que ir al nombre
 * nuevo: si no, el archivo que llega después parte la conversación en dos.
 */
export async function renombrarGrupoDeSubidas(cuestionarioId: string, grupo: string, nombre: string): Promise<void> {
  for (const subida of await listar(cuestionarioId)) {
    if (!subida.terminada && subida.grupo === grupo) await guardar(cuestionarioId, { ...subida, grupo: nombre })
  }
}

/** Al quitar una conversación: una subida a medias la resucitaría al terminar. */
export async function borrarSubidasDeGrupo(cuestionarioId: string, grupo: string | null): Promise<void> {
  for (const subida of await listar(cuestionarioId)) {
    if (!subida.terminada && subida.grupo === grupo) await borrar(cuestionarioId, subida.id)
  }
}

/** Borra lo que tiene más de un día en todos los cuestionarios: partes, datos y temporales. */
export async function limpiarSubidasVencidas(ahora = Date.now()): Promise<void> {
  let carpetas: string[]
  try {
    carpetas = await readdir(raizDeSubidas())
  } catch {
    return
  }
  for (const carpeta of carpetas) {
    const ruta = join(raizDeSubidas(), carpeta)
    const nombres = await readdir(ruta).catch(() => [] as string[])
    for (const nombre of nombres) {
      const archivo = join(ruta, nombre)
      const info = await stat(archivo).catch(() => null)
      if (info && ahora - info.mtimeMs >= HORAS_DE_VIDA * HORA) await rm(archivo, { force: true, recursive: true })
    }
    // Solo se va si quedó vacía.
    await rmdir(ruta).catch(() => undefined)
  }
}

const globalSubidas = globalThis as unknown as { _limpiezaDeSubidas?: NodeJS.Timeout }

/** Arranca una sola vez por proceso, desde instrumentation.ts. */
export function iniciarLimpiezaDeSubidas(): void {
  if (globalSubidas._limpiezaDeSubidas) return
  const correr = () => {
    limpiarSubidasVencidas().catch((err) => console.error('[subidas] falló la limpieza de subidas viejas:', err))
  }
  correr()
  globalSubidas._limpiezaDeSubidas = setInterval(correr, HORA)
  // Que el temporizador no mantenga vivo el proceso cuando Next quiere cerrarlo.
  globalSubidas._limpiezaDeSubidas.unref()
}
