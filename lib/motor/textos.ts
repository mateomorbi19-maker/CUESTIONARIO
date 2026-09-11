/**
 * Textos fijos que muestra la app sin pasar por la IA.
 *
 * Los que vienen de una skill están marcados: la prueba de contrato (pruebas/contrato.test.ts)
 * verifica que sigan apareciendo letra por letra en su SKILL.md. Si la skill cambia, la prueba
 * falla y se actualiza acá.
 */

// ---- De skills/mi-negocio/SKILL.md ----

export const INTRODUCCION_TRIAGE =
  'Antes de armarte el cuestionario necesito entender cómo funciona tu negocio. Seis preguntas, dos minutos.'

export const PREGUNTAS_TRIAGE = [
  'Pensá en el último chat que salió bien, uno que terminó como vos querías. ¿En qué terminó exactamente? Por ejemplo: la persona pagó, quedó agendada, la mandaste a la web, te dejó los datos y la llamaste después, te hizo un pedido.',
  'Esa última parte —la que hace que la conversación cuente como buena— ¿la hacés vos, alguien de tu equipo, o no la hace nadie y queda ahí?',
  'El que te escribe, ¿es alguien que aparece una vez y listo, o es alguien que vuelve seguido?',
  'Cuando te escriben, ¿hay algo que tengas que ir a fijarte antes de poder contestar? Agenda, stock, disponibilidad, precios que cambian, algo así.',
  '¿Cuántas personas te escriben por semana, más o menos? ¿Y cuántas de esas preguntan más o menos lo mismo?',
  'De atender esos chats, ¿qué es lo que más te rompe hoy?',
] as const

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
  'Todavía no subiste ni pegaste nada. Con conversaciones reales la entrevista sale mucho mejor, porque cada una muestra algo distinto de cómo vendés. Si no las tenés, podés seguir igual.'

export function avisoFaltantes(faltan: string[]): string {
  return `Te falta: ${faltan.join('; ')}. Cada conversación muestra algo distinto de cómo vendés, así que si las tenés, subilas o pegalas. Si no, podés seguir igual.`
}

export const GRACIAS =
  'Listo, terminaste. Gracias por el tiempo y por el detalle: con lo que contaste se arma el agente de tu negocio. Ya podés cerrar esta página.'
