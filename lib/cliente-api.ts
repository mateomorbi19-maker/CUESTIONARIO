import type {
  EstadoPublico,
  MotivoError,
  ParteRecibida,
  ResultadoSubida,
  SubidaCreada,
} from './estado-publico'
import {
  LIMITE_BYTES_ARCHIVO,
  PARTE_INICIAL,
  PARTE_MINIMA,
  TAMANO_PARTE,
  UMBRAL_MULTIPART,
} from './limites'
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
  /** Por qué, cuando el servidor lo dice. Con esto se decide qué hacer sin leer el mensaje. */
  readonly motivo?: MotivoError
  /** En las subidas por partes: los bytes que el servidor ya tiene. Se sigue desde ahí. */
  readonly recibidos?: number
  /** El mensaje lo escribió el servidor. Si no, es uno genérico armado acá según el código. */
  readonly delServidor: boolean

  constructor(
    estado: number,
    mensaje: string,
    extra: { motivo?: MotivoError; recibidos?: number; delServidor?: boolean } = {},
  ) {
    super(mensaje)
    this.name = 'ErrorApi'
    this.estado = estado
    this.motivo = extra.motivo
    this.recibidos = extra.recibidos
    this.delServidor = extra.delServidor ?? false
  }
}

// Una entrada vuelve enseguida porque se procesa en segundo plano. Si tarda más que esto, la
// conexión está trabada: mejor avisar que dejar el botón en «Guardando…» para siempre.
const LIMITE_PEDIDO_MS = 45_000

interface OpcionesPedido {
  limiteMs?: number
  /** Para cancelar desde afuera: la subida que la persona decidió no seguir. */
  senal?: AbortSignal
}

async function pedir<T>(
  ruta: string,
  opciones: RequestInit,
  { limiteMs = LIMITE_PEDIDO_MS, senal }: OpcionesPedido = {},
): Promise<T> {
  const corte = crearCorte(limiteMs, senal)
  try {
    let respuesta: Response
    try {
      respuesta = await fetch(ruta, {
        ...opciones,
        // El estado cambia con cada paso: una respuesta guardada por el navegador mostraría una
        // pantalla vieja.
        cache: 'no-store',
        signal: corte.senal,
      })
    } catch {
      if (senal?.aborted) throw new ErrorApi(0, 'Se canceló antes de terminar.')
      throw new ErrorApi(
        0,
        corte.porTiempo()
          ? 'La conexión está muy lenta y no llegó respuesta. Probá de nuevo en un momento.'
          : 'No hay conexión. Revisá que tengas internet y probá de nuevo.',
      )
    }

    const cuerpo = await leerCuerpo(respuesta)
    if (!respuesta.ok) throw errorDeRespuesta(cuerpo, respuesta.status)
    if (cuerpo === null) {
      throw new ErrorApi(
        respuesta.status,
        'La respuesta del servidor llegó incompleta. Recargá la página y probá de nuevo.',
      )
    }
    return cuerpo as T
  } finally {
    corte.soltar()
  }
}

/**
 * Corta el pedido si pasa el límite o si se cancela desde afuera. Con un AbortController propio
 * y no con AbortSignal.timeout: ese no existe en Safari anterior a la versión 16, y ahí una
 * parte trabada dejaría la subida colgada para siempre.
 */
function crearCorte(limiteMs: number, senal?: AbortSignal) {
  const control = new AbortController()
  let vencido = false
  const temporizador = setTimeout(() => {
    vencido = true
    control.abort()
  }, limiteMs)
  const cancelar = () => control.abort()
  if (senal?.aborted) control.abort()
  else senal?.addEventListener('abort', cancelar, { once: true })
  return {
    senal: control.signal,
    porTiempo: () => vencido,
    soltar() {
      clearTimeout(temporizador)
      senal?.removeEventListener('abort', cancelar)
    },
  }
}

async function leerCuerpo(respuesta: Response): Promise<unknown> {
  try {
    return await respuesta.json()
  } catch {
    // Un proxy caído o un corte a mitad de camino devuelven HTML o nada.
    return null
  }
}

function errorDeRespuesta(cuerpo: unknown, estado: number): ErrorApi {
  const datos = typeof cuerpo === 'object' && cuerpo !== null ? (cuerpo as Record<string, unknown>) : {}
  const motivo = typeof datos.motivo === 'string' ? (datos.motivo as MotivoError) : undefined
  const recibidos =
    typeof datos.recibidos === 'number' && Number.isFinite(datos.recibidos) ? datos.recibidos : undefined
  if (typeof datos.error === 'string' && datos.error.trim()) {
    return new ErrorApi(estado, datos.error, { motivo, recibidos, delServidor: true })
  }
  return new ErrorApi(estado, mensajeDeError(estado), { motivo, recibidos })
}

/** Sin mensaje del servidor (proxy, corte, error no previsto): uno que diga qué hacer. */
function mensajeDeError(estado: number): string {
  if (estado === 404) return 'No encontramos este cuestionario. Revisá que el link esté completo.'
  if (estado === 413) return 'La parte que se mandó es demasiado grande. Recargá la página y probá de nuevo.'
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

export function quitarArchivo(token: string, id: string) {
  return pedir<EstadoPublico>(`${rutaCuestionario(token)}/archivos/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// El nombre de la conversación va en el cuerpo y nunca en la URL: suele tener el nombre o el
// teléfono de un cliente, y las URL quedan en los registros del proxy.
export function quitarConversacion(token: string, grupo: string | null) {
  return pedir<EstadoPublico>(`${rutaCuestionario(token)}/conversaciones`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo }),
  })
}

export function renombrarConversacion(token: string, grupo: string, nombre: string) {
  return pedir<EstadoPublico>(`${rutaCuestionario(token)}/conversaciones`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo, nombre }),
  })
}

// ---------- Subir archivos ----------

/** A qué conversación va lo que se sube. */
export interface DestinoSubida {
  /** null: archivo suelto, o un .zip que arma su propia conversación con su nombre. */
  grupo: string | null
  /** La persona eligió o escribió esa conversación. false: se dedujo de la carpeta. */
  grupoElegido: boolean
}

export interface OpcionesSubida {
  /** Bytes de este archivo que el servidor ya tiene, después de cada parte. */
  alProgresar?: (enviados: number, total: number) => void
  senal?: AbortSignal
}

const MENSAJE_SUBIDA_CORTADA =
  'La subida se cortó. Revisá la conexión y tocá «Reintentar»: sigue desde donde quedó.'

// El proxy corta a los 60 segundos cualquier pedido cuyo cuerpo no terminó de llegar: estos
// límites son la red de abajo, para cuando la conexión se cuelga sin que nadie corte.
const LIMITE_ENTERO_MS = 2 * 60_000
const LIMITE_PARTE_MS = 90_000
// Al terminar, el servidor abre el .zip y guarda cada archivo de adentro.
const LIMITE_TERMINAR_MS = 3 * 60_000

const ESPERAS_ENTERO_MS = [1000, 3000]
const ESPERAS_PARTE_MS = [1000, 2000, 4000, 8000]
const ESPERAS_TERMINAR_MS = [2000]

// Una parte que tarda más que esto está demasiado cerca del corte del proxy: la que sigue va a la
// mitad. Una que tarda menos que lo otro deja margen para mandar el doble.
const PARTE_LENTA_MS = 20_000
const PARTE_RAPIDA_MS = 5_000

/** Sin respuesta o cortado por el proxy: lo mismo, un momento después, puede pasar. */
function esPasajero(err: unknown): err is ErrorApi {
  return err instanceof ErrorApi && [0, 499, 502, 503, 504].includes(err.estado)
}

function esperar(ms: number, senal?: AbortSignal): Promise<void> {
  return new Promise((listo) => {
    const temporizador = setTimeout(terminar, ms)
    function terminar() {
      clearTimeout(temporizador)
      senal?.removeEventListener('abort', terminar)
      listo()
    }
    senal?.addEventListener('abort', terminar, { once: true })
  })
}

async function conReintentos<T>(
  esperasMs: number[],
  senal: AbortSignal | undefined,
  intento: () => Promise<T>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await intento()
    } catch (err) {
      if (!esPasajero(err) || i >= esperasMs.length || senal?.aborted) throw err
      await esperar(esperasMs[i], senal)
    }
  }
}

// El tamaño de parte que viene funcionando. Queda para los archivos que siguen: la conexión es
// la misma, y arrancar cada video de nuevo con partes grandes repetiría los mismos cortes.
let parteActual = PARTE_INICIAL

function achicarParte() {
  parteActual = Math.max(PARTE_MINIMA, Math.floor(parteActual / 2))
}

function ajustarParte(tardoMs: number) {
  if (tardoMs > PARTE_LENTA_MS) achicarParte()
  else if (tardoMs < PARTE_RAPIDA_MS) parteActual = Math.min(TAMANO_PARTE, parteActual * 2)
}

interface SubidaAbierta {
  token: string
  id: string
  /** Hasta dónde llegó. El servidor puede tener más (una respuesta que se perdió) o menos. */
  desde: number
  tamanoParte: number
}

// Por archivo elegido, la subida que quedó a medias: «Reintentar» sigue esa en vez de empezar de
// cero. Es un WeakMap para que el archivo se libere cuando la pantalla lo suelta.
const abiertas = new WeakMap<File, SubidaAbierta>()

/**
 * Sube un archivo y devuelve el estado nuevo con el detalle de lo que se agregó.
 *
 * Los chicos van en un solo pedido. El resto va en partes, cada una muy por debajo del minuto
 * que tolera el proxy aun con mala señal: si una se corta se reintenta sola, y si no alcanza, el
 * próximo llamado con el mismo archivo sigue desde donde quedó.
 */
export async function subirArchivo(
  token: string,
  archivo: File,
  destino: DestinoSubida,
  opciones: OpcionesSubida = {},
): Promise<ResultadoSubida> {
  try {
    return archivo.size <= UMBRAL_MULTIPART
      ? await subirEntero(token, archivo, destino, opciones)
      : await subirPorPartes(token, archivo, destino, opciones)
  } catch (err) {
    // Se agotaron los reintentos. El mensaje genérico de un 504 («el servidor no pudo
    // responder») manda a esperar; acá lo que sirve es revisar la conexión y reintentar.
    if (esPasajero(err) && !err.delServidor && !opciones.senal?.aborted) {
      throw new ErrorApi(err.estado, MENSAJE_SUBIDA_CORTADA)
    }
    throw err
  }
}

async function subirEntero(
  token: string,
  archivo: File,
  destino: DestinoSubida,
  { alProgresar, senal }: OpcionesSubida,
): Promise<ResultadoSubida> {
  const formulario = new FormData()
  formulario.append('archivos', archivo)
  if (destino.grupo !== null) formulario.append('grupo', destino.grupo)
  if (destino.grupoElegido) formulario.append('grupoElegido', '1')
  // Sin Content-Type a mano: el navegador lo arma con el separador del multipart. Si la respuesta
  // se perdió y el archivo ya estaba guardado, el reintento lo informa como repetido y no lo duplica.
  const resultado = await conReintentos(ESPERAS_ENTERO_MS, senal, () =>
    pedir<ResultadoSubida>(
      `${rutaCuestionario(token)}/archivos`,
      { method: 'POST', body: formulario },
      { limiteMs: LIMITE_ENTERO_MS, senal },
    ),
  )
  alProgresar?.(archivo.size, archivo.size)
  return resultado
}

async function subirPorPartes(
  token: string,
  archivo: File,
  destino: DestinoSubida,
  { alProgresar, senal }: OpcionesSubida,
): Promise<ResultadoSubida> {
  const ruta = `${rutaCuestionario(token)}/subidas`
  // Cada vuelta es una subida entera. Se repite solo si el servidor ya no tiene la que se venía
  // usando (venció) o si al terminar dice que le faltan bytes.
  for (let vuelta = 0; ; vuelta++) {
    let abierta = abiertas.get(archivo)
    if (abierta?.token !== token) abierta = undefined
    try {
      if (!abierta) {
        // Si quedó una a medias de este mismo archivo (después de recargar la página, por
        // ejemplo), el servidor devuelve esa con lo que ya tiene y se sigue desde ahí.
        const creada = await conReintentos(ESPERAS_ENTERO_MS, senal, () =>
          pedir<SubidaCreada>(
            ruta,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                nombre: archivo.name,
                bytes: archivo.size,
                grupo: destino.grupo,
                grupoElegido: destino.grupoElegido,
              }),
            },
            { senal },
          ),
        )
        abierta = {
          token,
          id: creada.id,
          desde: acotar(creada.recibidos, archivo.size),
          tamanoParte: creada.tamanoParte > 0 ? Math.min(creada.tamanoParte, TAMANO_PARTE) : TAMANO_PARTE,
        }
        abiertas.set(archivo, abierta)
      }
      const rutaSubida = `${ruta}/${encodeURIComponent(abierta.id)}`
      alProgresar?.(abierta.desde, archivo.size)
      await mandarPartes(rutaSubida, archivo, abierta, alProgresar, senal)
      const resultado = await conReintentos(ESPERAS_TERMINAR_MS, senal, () =>
        pedir<ResultadoSubida>(
          `${rutaSubida}/terminar`,
          { method: 'POST' },
          { limiteMs: LIMITE_TERMINAR_MS, senal },
        ),
      )
      abiertas.delete(archivo)
      return resultado
    } catch (err) {
      if (!(err instanceof ErrorApi) || vuelta >= 2 || senal?.aborted) throw err
      if (err.estado === 410 || err.motivo === 'subida_vencida') {
        // Venció o ya no existe: se arranca otra sin molestar a nadie.
        abiertas.delete(archivo)
        continue
      }
      if (abierta && err.estado === 409 && err.recibidos !== undefined) {
        // Al terminar, el servidor tiene menos de lo que se creía: se completa desde ahí.
        abierta.desde = acotar(err.recibidos, archivo.size)
        continue
      }
      throw err
    }
  }
}

async function mandarPartes(
  rutaSubida: string,
  archivo: File,
  abierta: SubidaAbierta,
  alProgresar: OpcionesSubida['alProgresar'],
  senal: AbortSignal | undefined,
): Promise<void> {
  let fallasSeguidas = 0
  let saltos = 0
  while (abierta.desde < archivo.size) {
    const desde = abierta.desde
    const largo = Math.min(parteActual, abierta.tamanoParte, archivo.size - desde)
    const inicio = Date.now()
    try {
      const { recibidos } = await pedir<ParteRecibida>(
        `${rutaSubida}?desde=${desde}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: archivo.slice(desde, desde + largo),
        },
        { limiteMs: LIMITE_PARTE_MS, senal },
      )
      ajustarParte(Date.now() - inicio)
      fallasSeguidas = 0
      // Manda lo que dice el servidor, pero nunca para atrás de lo recién mandado: una respuesta
      // rara no puede dejar la subida dando vueltas en el mismo lugar.
      abierta.desde = Math.max(desde + largo, acotar(recibidos, archivo.size))
      alProgresar?.(abierta.desde, archivo.size)
    } catch (err) {
      if (!(err instanceof ErrorApi) || senal?.aborted) throw err
      if (err.estado === 409 && err.recibidos !== undefined && saltos < 8) {
        // El servidor tiene menos (o más) de lo que se creía: se sigue desde lo que él dice.
        saltos++
        abierta.desde = acotar(err.recibidos, archivo.size)
        alProgresar?.(abierta.desde, archivo.size)
        continue
      }
      if (!esPasajero(err) || fallasSeguidas >= ESPERAS_PARTE_MS.length) throw err
      // Sin respuesta o cortada por el proxy: llegó tarde. Con la mitad entra en el minuto. Un
      // 502 o 503 no es lentitud, es el servidor reiniciándose: ahí solo se espera.
      if ([0, 499, 504].includes(err.estado)) achicarParte()
      await esperar(ESPERAS_PARTE_MS[fallasSeguidas], senal)
      fallasSeguidas++
    }
  }
}

function acotar(valor: number, maximo: number): number {
  return Number.isFinite(valor) ? Math.min(maximo, Math.max(0, Math.floor(valor))) : 0
}

/**
 * Deja de lado la subida a medias de ese archivo: el servidor borra lo que ya había recibido, que
 * si no cuenta para el espacio del cuestionario hasta que vence.
 */
export async function descartarSubida(token: string, archivo: File): Promise<void> {
  const abierta = abiertas.get(archivo)
  if (!abierta || abierta.token !== token) return
  abiertas.delete(archivo)
  try {
    await pedir<unknown>(`${rutaCuestionario(token)}/subidas/${encodeURIComponent(abierta.id)}`, {
      method: 'DELETE',
    })
  } catch {
    // Si no se pudo avisar, vence sola en el servidor.
  }
}

/**
 * Lo que el servidor va a rechazar seguro, dicho antes de subirlo: un video de 300 MB por datos
 * móviles tarda y gasta para nada. El servidor valida igual; esto solo ahorra la espera.
 */
export function problemaDeArchivo(archivo: File): string | null {
  if (archivo.size === 0) {
    return `«${archivo.name}» está vacío. Volvé a guardarlo o exportarlo y subilo de nuevo.`
  }
  if (archivo.size > LIMITE_BYTES_ARCHIVO) {
    return `«${archivo.name}» pesa más de 200 MB. Si es un video, mandá uno más corto o el que quedó en WhatsApp; si es un .zip, exportá cada conversación por separado.`
  }
  return null
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
