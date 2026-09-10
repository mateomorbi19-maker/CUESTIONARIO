import type { Examen, LetraArquetipo } from '../examen'

/**
 * En qué parte del recorrido está un cuestionario. El orden es el de la skill `mi-negocio`;
 * la entrevista y el cierre se suman como etapas nuevas después de `material`.
 */
export type Etapa =
  /** Fase 0: las seis preguntas. */
  | 'triage'
  /** Fase 0.5: las respuestas no alcanzan y se pide un chat real. */
  | 'pedido_chat'
  /** Fase 0.5: no guarda los chats; tres preguntas para reconstruir el último. */
  | 'reconstruccion'
  /** Fase 1: el negocio tiene dos procesos y elige con cuál arrancar. */
  | 'eleccion'
  /** Fase 1: se le dice cómo se entendió su negocio y confirma o corrige. */
  | 'confirmacion'
  /** Examen listo: junta el material de la sección 0. */
  | 'material'

export interface Intercambio {
  /** Lo que se le mostró, tal cual. */
  pregunta: string
  respuesta: string
}

/** Lo que la IA entendió del negocio en la Fase 1. */
export interface Clasificacion {
  accionTerminal: string
  arquetipo: LetraArquetipo
  /** Dos procesos distintos conviviendo: hay que elegir uno antes de seguir. */
  hibrido: boolean
  /** Si es híbrido, los procesos con las palabras del dueño. */
  procesos: string[]
  /** El mensaje de la Fase 1 para el dueño, que termina preguntando si va bien. */
  mensaje: string
}

export interface EstadoCuestionario {
  etapa: Etapa
  negocio: string
  triage: {
    /** Cuál de las seis preguntas se está contestando: de 0 a 5. */
    indice: number
    intercambios: Intercambio[]
    /** La repregunta en curso. La skill permite una sola por pregunta. */
    repregunta: string | null
  }
  /** Chat real pegado en la Fase 0.5. */
  chat: string | null
  reconstruccion: Intercambio[]
  clasificacion: Clasificacion | null
  /** Correcciones del dueño a la clasificación, en orden. */
  correcciones: string[]
  procesoElegido: string | null
  examen: Examen | null
  /** Lo que la validación del examen no pudo resolver con los reintentos. Va al reporte. */
  pendientesExamen: string[]
}

/** Lo que la pantalla tiene que mostrar. La arma el motor a partir del estado. */
export type Pantalla =
  | {
      tipo: 'pregunta'
      /** Identifica la pregunta: "triage.1", "reconstruccion.2". */
      clave: string
      introduccion: string | null
      texto: string
      esRepregunta: boolean
    }
  | { tipo: 'pedido_chat'; texto: string; sinChat: string }
  | { tipo: 'eleccion'; texto: string; opciones: string[] }
  | { tipo: 'confirmacion'; texto: string }
  | { tipo: 'material'; items: string[] }

/** Lo que manda la pantalla. */
export type Entrada =
  | { tipo: 'respuesta'; texto: string }
  | { tipo: 'sin_chat' }
  | { tipo: 'eleccion'; opcion: string }
  | { tipo: 'confirmar' }
  | { tipo: 'corregir'; texto: string }
