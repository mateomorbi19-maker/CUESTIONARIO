/**
 * Textos fijos que muestra la app sin pasar por la IA.
 *
 * Los que vienen de una skill están marcados: la prueba de contrato (pruebas/contrato.test.ts)
 * verifica que sigan apareciendo letra por letra en su SKILL.md. Si la skill cambia, la prueba
 * falla y se actualiza acá.
 */

// ---- De skills/mi-negocio/SKILL.md, reescritos para el formulario ----

export interface PreguntaTriage {
  /** El número de la pregunta de la Fase 0 de la skill que reemplaza. */
  enLaSkill: number
  texto: string
}

/**
 * Las preguntas de la Fase 0 en palabras simples. En la skill las hace alguien que puede
 * aclarar; acá el dueño las lee solo, y las originales se entendían mal. Cada una dice qué
 * pregunta de la skill reemplaza: la IA la evalúa con lo que busca esa, y la prueba de contrato
 * verifica que exista.
 *
 * La 2 de la skill («¿la hacés vos, alguien de tu equipo, o no la hace nadie?») no se hace: en
 * los negocios que llegan acá la última parte del chat bueno la hacen siempre el dueño o su
 * equipo, a mano, y la pregunta no se entendía.
 */
export const PREGUNTAS_TRIAGE: readonly PreguntaTriage[] = [
  {
    enLaSkill: 1,
    texto:
      'Pensá en el último chat con un cliente que terminó bien. ¿En qué terminó? Por ejemplo: te pagó, reservó un turno, te hizo un pedido o te dejó sus datos para llamarlo después.',
  },
  {
    enLaSkill: 3,
    texto: 'La mayoría de los que te escriben, ¿son personas nuevas o clientes que vuelven?',
  },
  {
    enLaSkill: 4,
    texto:
      'Antes de contestar un mensaje, ¿tenés que revisar algo? Por ejemplo: la agenda, el stock, una lista de precios o si tenés lugar.',
  },
  {
    enLaSkill: 5,
    texto: 'Más o menos, ¿cuántas personas te escriben por semana? ¿Qué es lo que te pregunta casi todo el mundo?',
  },
  {
    enLaSkill: 6,
    texto: 'De atender los chats, ¿qué es lo que más tiempo te lleva o lo que más te complica hoy?',
  },
]

export const INTRODUCCION_TRIAGE =
  'Antes de armarte el cuestionario necesito entender cómo funciona tu negocio. Son cinco preguntas cortas.'

// ---- De skills/mi-negocio/SKILL.md ----

export const REPREGUNTA_ACCION_TERMINAL =
  '¿Y qué fue lo último que hiciste vos en ese chat? ¿Le mandaste un link, lo anotaste en algún lado, le pasaste un dato?'

export const PEDIDO_CHAT =
  'Con esto no puedo armarte un cuestionario a medida. Necesito material real: pegame la última conversación de WhatsApp de tu negocio que terminó bien.'

export const PREGUNTAS_RECONSTRUCCION = [
  '¿Qué te escribió la persona? Lo primero que te llegó.',
  '¿Qué le contestaste vos?',
  '¿En qué terminó?',
] as const

export const NOTA_GENERICO =
  'Este cuestionario es general para tu rubro. A medida que lo contestes con casos reales lo vamos afinando.'

export const ELECCION_HIBRIDO =
  'Tenés dos procesos distintos conviviendo. La primera versión del agente sirve a uno solo, después le sumás el otro. ¿Cuál te resuelve más problema hoy?'

// ---- De skills/entrevista/SKILL.md ----

/** Regla dura 4: cuando contesta lo que "debería decir el bot" en vez de lo que hace hoy. */
export const FRASE_RESPONDE_COMO_AGENTE = 'Pará. No me digas qué debería decir el agente. Decime qué decís vos hoy.'

// ---- De la app ----

export const SIN_CHAT = 'No guardo los chats'

export const AVISO_SIN_MATERIAL =
  'Todavía no subiste nada. Con conversaciones reales la entrevista sale mucho mejor, porque cada una muestra algo distinto de cómo vendés. Si no las tenés, podés seguir igual.'

/** Junto a un archivo que Claude no pudo leer: una imagen rechazada o que no terminó de transcribirse. */
export const PROBLEMA_ILEGIBLE = 'No pudimos leer este archivo. Si tiene algo importante, mandalo de nuevo como captura de pantalla.'

/** Junto a un archivo que se perdió en el servidor después de subirlo. */
export const PROBLEMA_PERDIDO = 'Este archivo no se guardó bien. Si tiene algo importante, subilo de nuevo.'

/** Junto a un PDF tan largo que solo se leyó el principio. */
export const PROBLEMA_LARGO = 'Es muy largo: leímos solo la primera parte. Si lo importante está más adelante, subí esa parte sola.'

/** Al final de lo que se alcanzó a leer de un PDF largo, para que la entrevista sepa que falta el resto. */
export const MARCA_TRANSCRIPCION_CORTADA = '[Acá se cortó la lectura: el archivo es demasiado largo y lo que sigue no se leyó.]'

/** Junto a un audio que no se pudo transcribir. El dueño no puede volver a grabar el audio de un cliente: se le pide que lo cuente. */
export const PROBLEMA_AUDIO = 'No pudimos escuchar este audio. Si dice algo importante, contalo cuando te pregunten.'

/** Junto a un video del que no se pudo sacar ni la imagen ni el audio. */
export const PROBLEMA_VIDEO = 'No pudimos ver este video. Si muestra algo importante, contalo cuando te pregunten.'

/** Junto a un archivo de un tipo que no se lee. El mismo texto está en lib/archivos.ts, que no depende del motor. */
export const PROBLEMA_FORMATO =
  'Este tipo de archivo no lo podemos leer. Queda guardado igual: si tiene algo importante, mandalo como PDF, captura o texto.'

/** Un pedido a Claude no puede pasar de 32 MB y el PDF viaja en base64, que ocupa un tercio más. */
export const PROBLEMA_PDF_PESADO =
  'El PDF pesa más de 22 MB y así no se puede leer. Si tiene algo importante, subí solo las páginas que importan.'

/** Junto a un audio o un video cuya transcripción no llegó a terminar dentro del plazo. La pantalla no lo muestra como problema. */
export const PROBLEMA_EN_PROCESO = 'Todavía lo estamos escuchando.'

/** Volvió a la lista porque algo no se pudo leer. Las notas están en la tarjeta de cada conversación, que se muestra abierta. */
export const AVISO_LECTURA =
  'No pudimos leer entero todo lo que subiste: fijate la nota en cada conversación. Podés quitarlo, subir otra versión o **seguir igual**.'

/** Volvió a la lista porque se venció el plazo de lectura. Lo que falta sigue en segundo plano. */
export const AVISO_EN_PROCESO =
  'Todavía estamos escuchando algunos audios y videos. Esperá unos minutos y tocá **Listo, seguir** otra vez: lo que ya leímos queda guardado.'

/** En lugar de la transcripción de un audio sin voz: Whisper inventa palabras con el silencio. */
export const TEXTO_SIN_VOZ = '(no se escucha a nadie hablando)'

export function avisoFaltantes(faltan: string[]): string {
  return `Te falta: ${faltan.join('; ')}. Cada conversación muestra algo distinto de cómo vendés, así que si las tenés, subilas. Si no, podés seguir igual.`
}

export const GRACIAS =
  'Listo, terminaste. Gracias por el tiempo y por el detalle: con lo que contaste se arma el agente de tu negocio. Ya podés cerrar esta página.'
