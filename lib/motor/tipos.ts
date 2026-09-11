import type { Examen, LetraArquetipo } from '../examen'

/**
 * En qué parte del recorrido está un cuestionario. Las primeras cinco son la skill
 * `mi-negocio`; desde `material`, la skill `entrevista`.
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
  /** La entrevista, sección por sección y pregunta por pregunta. */
  | 'entrevista'
  /** Lo que el cierre interno encontró incompleto, preguntado como preguntas comunes. */
  | 'preguntas_finales'
  /** Entregables listos y aviso enviado. El cliente solo ve el agradecimiento. */
  | 'terminado'

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

export type TipoMaterial = 'imagen' | 'pdf' | 'texto'

export interface ArchivoMaterial {
  id: string
  nombre: string
  mime: string
  tipo: TipoMaterial
  bytes: number
  /** Texto extraído al subirlo o transcripto por Claude. null mientras falta transcribirlo. */
  texto: string | null
  /** Los que se suben en `pedido_chat` son el chat real del triage. */
  etapa: 'pedido_chat' | 'material'
}

export interface TextoMaterial {
  id: string
  texto: string
}

/** Texto sacado del material que ya contesta una pregunta: se le muestra para confirmar. */
export interface Propuesta {
  texto: string
  /** De dónde salió: nombre del archivo o "texto pegado". */
  fuente: string
}

export type EstadoRespuesta = 'completa' | 'pendiente' | 'no_aplica'

export interface RespuestaEntrevista {
  intercambios: Intercambio[]
  estado: EstadoRespuesta
  /** La propuesta que se le mostró, si hubo. */
  propuesta: Propuesta | null
  /** Confirmó la propuesta tal cual, sin cambios. */
  sigueIgual: boolean
  /** Suena a algo que planea hacer y no a algo que ya hace: va al reporte. */
  esPlan: boolean
  /** Para el brief: qué falta si quedó pendiente, o el motivo si no aplica. */
  nota: string
}

/** Lo que encontró el cierre de la entrevista. Nunca se le muestra al cliente. */
export interface AnalisisCierre {
  estilo: string
  contradicciones: { detalle: string; pregunta: string }[]
  cobertura: { campo: string; estado: 'completo' | 'incompleto' | 'no_aplica'; detalle: string }[]
  simulaciones: { titulo: string; conversacion: string }[]
  /** Lo que hubo que inventar en las simulaciones: cada uno es un hueco del brief. */
  agujeros: { detalle: string; pregunta: string }[]
}

export interface PreguntaFinal {
  texto: string
  motivo: string
  respuesta: string | null
}

/** Los archivos que se le mandan a Mateo. */
export interface Entregables {
  examen: string
  brief: string
  claude: string
  cierre: string
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
  /** Chat real de la Fase 0.5, pegado o transcripto de lo que subió. */
  chat: string | null
  reconstruccion: Intercambio[]
  clasificacion: Clasificacion | null
  /** Correcciones del dueño a la clasificación, en orden. */
  correcciones: string[]
  procesoElegido: string | null
  examen: Examen | null
  /** Lo que la validación del examen no pudo resolver con los reintentos. Va al reporte. */
  pendientesExamen: string[]
  material: {
    archivos: ArchivoMaterial[]
    textos: TextoMaterial[]
    /** Lo que falta juntar, dicho una sola vez. La skill no insiste más. */
    avisoFaltantes: string | null
  }
  entrevista: {
    /** Sección en curso: de 1 a 9. */
    seccion: number
    /** Pregunta en curso dentro de la sección. */
    indice: number
    repregunta: string | null
    /** Por id de pregunta ("3.2"). */
    respuestas: Record<string, RespuestaEntrevista>
    /** Por id de pregunta: lo que el material ya contesta. */
    propuestas: Record<string, Propuesta>
    /** Secciones del brief ya escritas, por número de sección. */
    brief: Record<string, string>
  }
  cierre: AnalisisCierre | null
  preguntasFinales: PreguntaFinal[]
  entregables: Entregables | null
  /** Lo que no frenó el recorrido pero conviene revisar. Va al reporte. */
  avisos: string[]
}

/** Lo que el cliente ve de un archivo que subió. */
export interface ArchivoPublico {
  id: string
  nombre: string
  tipo: TipoMaterial
}

export interface TextoPublico {
  id: string
  /** Primeros caracteres, para reconocerlo en la lista. */
  extracto: string
}

/** Lo que la pantalla tiene que mostrar. La arma el motor a partir del estado. */
export type Pantalla =
  | {
      /** Triage y reconstrucción del chat. */
      tipo: 'pregunta'
      /** Identifica la pregunta: "triage.1", "reconstruccion.2". Sirve para guardar borradores. */
      clave: string
      introduccion: string | null
      texto: string
      esRepregunta: boolean
    }
  | { tipo: 'pedido_chat'; texto: string; sinChat: string; archivos: ArchivoPublico[] }
  | { tipo: 'eleccion'; texto: string; opciones: string[] }
  | { tipo: 'confirmacion'; texto: string }
  | {
      tipo: 'material'
      items: string[]
      archivos: ArchivoPublico[]
      textos: TextoPublico[]
      /** Lo que falta juntar, si se detectó. Con aviso, el botón de seguir dice que no tiene más. */
      aviso: string | null
    }
  | {
      tipo: 'entrevista'
      seccion: { numero: number; titulo: string }
      pregunta: { id: string; texto: string }
      /** 'texto_literal' en las secciones 5, 6 y 9: se pega tal cual se le escribe a un cliente. */
      formato: 'dato' | 'texto_literal'
      propuesta: Propuesta | null
      repregunta: string | null
    }
  | { tipo: 'pregunta_final'; numero: number; total: number; texto: string }
  | { tipo: 'gracias'; texto: string }

/** Lo que manda la pantalla. */
export type Entrada =
  /** Triage, reconstrucción, pedido de chat (puede ir vacía si subió archivos), entrevista y preguntas finales. */
  | { tipo: 'respuesta'; texto: string }
  | { tipo: 'sin_chat' }
  | { tipo: 'eleccion'; opcion: string }
  | { tipo: 'confirmar' }
  | { tipo: 'corregir'; texto: string }
  /** Material: pegar un texto (un chat copiado, una lista de precios). */
  | { tipo: 'texto_material'; texto: string }
  | { tipo: 'quitar_texto'; id: string }
  /** Material: listo, seguir con la entrevista. */
  | { tipo: 'terminar_material' }
  /** Entrevista: la propuesta sacada del material sigue siendo así. */
  | { tipo: 'sigue_igual' }
  /** Entrevista: la pregunta no aplica a su negocio, con el motivo. */
  | { tipo: 'no_aplica'; texto: string }
  /** Entrevista y preguntas finales: no lo sabe. Queda pendiente. */
  | { tipo: 'no_se' }
