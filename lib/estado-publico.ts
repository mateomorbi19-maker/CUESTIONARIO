import type { Entrada, Etapa, Pantalla } from './motor/tipos'

/**
 * Lo que la API le devuelve a la pantalla sobre un cuestionario. Nunca incluye el brief, la
 * clasificación interna ni nada del cierre: el cliente no ve el resultado del trabajo.
 */
export interface EstadoPublico {
  /** Hay que mandarla con cada entrada: si no coincide, otra pestaña avanzó y hay que recargar. */
  version: number
  /** Para decirle de qué negocio es el cuestionario y a qué mail le llegó el link para seguir. */
  negocio: string
  email: string
  etapa: Etapa
  /** true: se está procesando la última entrada. Mostrar la espera y volver a pedir el estado cada 2 segundos. */
  procesando: boolean
  /** Qué se está haciendo mientras se procesa, para la pantalla de espera. */
  mensajeEspera: string | null
  /** El último intento falló. Mostrarlo y ofrecer reintentar mandando `entradaPendiente` otra vez. */
  error: string | null
  entradaPendiente: Entrada | null
  progreso: { porcentaje: number; texto: string }
  pantalla: Pantalla
}

/** Respuesta de error de cualquier ruta de la API. */
export interface ErrorPublico {
  error: string
}
