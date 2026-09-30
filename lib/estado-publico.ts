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

/**
 * Por qué falló un pedido, para que la pantalla decida sin leer el mensaje: los textos cambian,
 * los motivos no.
 */
export type MotivoError =
  /** 404: el token no existe. ÚNICO caso en que la pantalla da el link por inválido. */
  | 'link'
  /** 409: otra pestaña avanzó. El cliente recarga el estado y reintenta solo. */
  | 'version'
  /** 409: se está procesando una respuesta. Se muestra el mensaje. */
  | 'procesando'
  /** 409: este paso no admite archivos. Se recarga el estado. */
  | 'etapa'
  /** 409 en subidas: viene con `recibidos`; se sigue desde ahí. */
  | 'faltan_bytes'
  /** 409: esa conversación ya tiene otro chat. El cliente renombra el lote a «Nombre (2)» y reintenta. */
  | 'grupo_con_otro_chat'
  /** 409: el archivo o la conversación ya no existe. Se recarga el estado, sin error a la vista. */
  | 'ya_no_esta'
  /** 410: la subida por partes venció o no existe. El cliente crea otra y sigue, sin mostrar error. */
  | 'subida_vencida'

/** Respuesta de error de cualquier ruta de la API. */
export interface ErrorPublico {
  error: string
  motivo?: MotivoError
  /** Solo en los 409 de subidas por partes: bytes que el servidor ya tiene. */
  recibidos?: number
}

export interface DetalleSubida {
  /** Archivos nuevos en el material. Un .zip suma uno por cada archivo de adentro. */
  agregados: number
  /** Ya estaban en esa conversación (mismo nombre y mismos bytes). No se guardaron de nuevo. */
  repetidos: number
  /** Lo que venía en un .zip y no se pudo sacar (cifrado, dañado, enlace). */
  omitidos: { nombre: string; motivo: string }[]
  /** Conversaciones donde quedó lo subido, sin repetir. null: suelto. */
  grupos: (string | null)[]
}

/**
 * Lo que devuelven las subidas: un EstadoPublico con el detalle al lado. Así, una pestaña vieja
 * que quedó abierta durante un deploy (y espera un EstadoPublico pelado) lo sigue entendiendo.
 */
export interface ResultadoSubida extends EstadoPublico {
  subida: DetalleSubida
}

/** Una subida por partes recién creada, o una abierta del mismo archivo que se retoma. */
export interface SubidaCreada {
  id: string
  /** Más de 0 si se retoma una que quedó a medias: se sigue desde ahí. */
  recibidos: number
  /** Lo máximo que el servidor acepta por parte. */
  tamanoParte: number
}

export interface ParteRecibida {
  recibidos: number
}
