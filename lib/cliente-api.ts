import type { EstadoPublico } from './estado-publico'
import type { Entrada } from './motor/tipos'

/**
 * Lo que usa el navegador para hablar con la API (docs/API.md) y para guardar en el
 * dispositivo lo que no conviene perder: el link del cuestionario y lo que se va escribiendo.
 *
 * Solo se llama desde componentes cliente: usa `fetch` con rutas relativas y `localStorage`.
 */

/** Error de la API con un mensaje listo para mostrarle al cliente. */
export class ErrorApi extends Error {
  /** Código HTTP. 0 cuando no llegó respuesta: sin conexión o se cortó a mitad de camino. */
  readonly estado: number

  constructor(estado: number, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorApi'
    this.estado = estado
  }
}

// Una entrada vuelve enseguida porque se procesa en segundo plano. Si tarda más que esto, la
// conexión está trabada: mejor avisar que dejar el botón en «Guardando…» para siempre.
const LIMITE_PEDIDO_MS = 45_000
// 20 MB por datos móviles lentos pueden tardar varios minutos en subir.
const LIMITE_SUBIDA_MS = 10 * 60_000

async function pedir<T>(ruta: string, opciones: RequestInit, limiteMs = LIMITE_PEDIDO_MS): Promise<T> {
  let respuesta: Response
  try {
    respuesta = await fetch(ruta, {
      ...opciones,
      // El estado cambia con cada paso: una respuesta guardada por el navegador mostraría una
      // pantalla vieja.
      cache: 'no-store',
      signal: senalConLimite(limiteMs),
    })
  } catch (err) {
    const porTiempo =
      err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new ErrorApi(
      0,
      porTiempo
        ? 'La conexión está muy lenta y no llegó respuesta. Probá de nuevo en un momento.'
        : 'No hay conexión. Revisá que tengas internet y probá de nuevo.',
    )
  }

  const cuerpo = await leerCuerpo(respuesta)
  if (!respuesta.ok) {
    throw new ErrorApi(respuesta.status, mensajeDeError(cuerpo, respuesta.status))
  }
  if (cuerpo === null) {
    throw new ErrorApi(
      respuesta.status,
      'La respuesta del servidor llegó incompleta. Recargá la página y probá de nuevo.',
    )
  }
  return cuerpo as T
}

function senalConLimite(ms: number): AbortSignal | undefined {
  // Safari anterior a la versión 16 no trae AbortSignal.timeout: ahí se espera sin límite.
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

async function leerCuerpo(respuesta: Response): Promise<unknown> {
  try {
    return await respuesta.json()
  } catch {
    // Un proxy caído o un corte a mitad de camino devuelven HTML o nada.
    return null
  }
}

function mensajeDeError(cuerpo: unknown, estado: number): string {
  if (
    typeof cuerpo === 'object' &&
    cuerpo !== null &&
    'error' in cuerpo &&
    typeof cuerpo.error === 'string' &&
    cuerpo.error.trim()
  ) {
    return cuerpo.error
  }
  // Sin mensaje del servidor (proxy, corte, error no previsto): uno que diga qué hacer.
  if (estado === 404) return 'No encontramos este cuestionario. Revisá que el link esté completo.'
  if (estado === 413) return 'El archivo es demasiado grande: el máximo es 20 MB.'
  if (estado === 429) return 'Hubo demasiados pedidos seguidos. Esperá unos minutos y probá de nuevo.'
  if (estado >= 500) return 'El servidor no pudo responder. Probá de nuevo en unos minutos.'
  return 'No se pudo completar. Recargá la página y probá de nuevo.'
}

function rutaCuestionario(token: string): string {
  return `/api/cuestionarios/${encodeURIComponent(token)}`
}

/** Nuevo, o el aviso de que ese mail ya tenía uno empezado y se le mandó el link para seguir. */
export type Inicio = { token: string; url: string } | { retomado: true; email: string }

export function crearCuestionario(datos: { codigo: string; negocio: string; email: string }) {
  return pedir<Inicio>('/api/cuestionarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos),
  })
}

export function leerEstado(token: string) {
  return pedir<EstadoPublico>(rutaCuestionario(token), { method: 'GET' })
}

export function mandarEntrada(token: string, entrada: Entrada, version: number) {
  return pedir<EstadoPublico>(`${rutaCuestionario(token)}/entrada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entrada, version }),
  })
}

export function subirArchivos(token: string, archivos: File[]) {
  const formulario = new FormData()
  for (const archivo of archivos) formulario.append('archivos', archivo)
  // Sin Content-Type a mano: el navegador lo arma con el separador del multipart.
  return pedir<EstadoPublico>(
    `${rutaCuestionario(token)}/archivos`,
    { method: 'POST', body: formulario },
    LIMITE_SUBIDA_MS,
  )
}

export function quitarArchivo(token: string, id: string) {
  return pedir<EstadoPublico>(`${rutaCuestionario(token)}/archivos/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** Para el `accept` del selector. Es la lista de docs/API.md. */
export const TIPOS_ACEPTADOS =
  'image/jpeg,image/png,image/webp,image/gif,application/pdf,.docx,.xlsx,.txt,.csv,.md,.zip'

const MAXIMO_BYTES = 20 * 1024 * 1024
const EXTENSIONES_ACEPTADAS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'docx', 'xlsx', 'txt', 'csv', 'md', 'zip']
const IMAGENES_ACEPTADAS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/**
 * Lo que el servidor va a rechazar seguro, dicho antes de subirlo: un video de 80 MB por datos
 * móviles tarda y gasta para nada. El servidor valida igual; esto solo ahorra la espera.
 */
export function problemaDeArchivo(archivo: File): string | null {
  if (archivo.size > MAXIMO_BYTES) {
    return `«${archivo.name}» pesa más de 20 MB. Si es un PDF, probá achicarlo; si es un chat, mandá capturas o el .zip que exporta WhatsApp.`
  }
  const extension = archivo.name.includes('.') ? archivo.name.split('.').pop()!.toLowerCase() : ''
  // Algunos celulares comparten imágenes sin extensión en el nombre: ahí manda el tipo.
  if (EXTENSIONES_ACEPTADAS.includes(extension) || IMAGENES_ACEPTADAS.includes(archivo.type)) {
    return null
  }
  return `«${archivo.name}» no se puede subir. Van fotos y capturas (JPG, PNG, WEBP, GIF), PDF, Word, Excel, archivos de texto y el .zip que exporta WhatsApp. Audios y videos, no.`
}

// localStorage puede no estar (almacenamiento bloqueado, modo privado viejo de Safari) o estar
// lleno. Nada de lo que se guarda es imprescindible: si falla, se sigue sin guardar.
function leerLocal(clave: string): string | null {
  try {
    return window.localStorage.getItem(clave)
  } catch {
    return null
  }
}

function escribirLocal(clave: string, valor: string) {
  try {
    window.localStorage.setItem(clave, valor)
  } catch {
    // Ver arriba: sin almacenamiento se sigue igual.
  }
}

function borrarLocal(clave: string) {
  try {
    window.localStorage.removeItem(clave)
  } catch {
    // Ver arriba.
  }
}

const CLAVE_TOKEN = 'cuestionario:token'

export function leerTokenGuardado(): string | null {
  return leerLocal(CLAVE_TOKEN)
}

export function guardarToken(token: string) {
  escribirLocal(CLAVE_TOKEN, token)
}

/** Solo lo borra si es ese: otra pestaña pudo haber guardado uno distinto. */
export function olvidarToken(token: string) {
  if (leerLocal(CLAVE_TOKEN) === token) borrarLocal(CLAVE_TOKEN)
}

/** Para `useSyncExternalStore`: avisa cuando otra pestaña cambia lo guardado. */
export function escucharAlmacen(aviso: () => void) {
  window.addEventListener('storage', aviso)
  return () => window.removeEventListener('storage', aviso)
}

function claveBorrador(token: string, clave: string) {
  return `borrador:${token}:${clave}`
}

export function leerBorrador(token: string, clave: string): string {
  return leerLocal(claveBorrador(token, clave)) ?? ''
}

export function guardarBorrador(token: string, clave: string, texto: string) {
  if (texto) escribirLocal(claveBorrador(token, clave), texto)
  else borrarLocal(claveBorrador(token, clave))
}

export function borrarBorrador(token: string, clave: string) {
  borrarLocal(claveBorrador(token, clave))
}

/** Al terminar el cuestionario no queda nada escrito en el dispositivo. */
export function borrarBorradores(token: string) {
  try {
    const prefijo = claveBorrador(token, '')
    const claves: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const clave = window.localStorage.key(i)
      if (clave?.startsWith(prefijo)) claves.push(clave)
    }
    for (const clave of claves) window.localStorage.removeItem(clave)
  } catch {
    // Ver leerLocal.
  }
}
