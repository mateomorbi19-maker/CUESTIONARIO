/**
 * Verificación de texto literal.
 *
 * En las secciones 5, 6 y 9 el brief guarda lo que el dueño le escribe a un cliente, tal cual:
 * para un negocio que cuida su guion, una frase "emprolijada" por la IA es una frase que el
 * dueño no reconoce y el agente va a repetir. Esto encuentra en el markdown del brief los
 * textos citados y dice cuáles no aparecen en lo que el dueño contestó o subió.
 */

/** Espacios y comillas tipográficas unificados: no cambian el texto, sí la comparación. */
export function normalizarLiteral(texto: string): string {
  return texto
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// Solo se controlan citas con cuerpo: una palabra suelta entre comillas no es un mensaje.
const LARGO_MINIMO = 15

function sinComillasExternas(texto: string): string {
  return texto.replace(/^["'\s]+|["'\s]+$/g, '')
}

function esMarcador(texto: string): boolean {
  return /^(NO APLICA|\[PENDIENTE)/i.test(texto)
}

/** Las citas del markdown: lo que sigue a "R:" y lo que está entre comillas. */
export function citasDelMarkdown(markdown: string): string[] {
  const citas = new Set<string>()
  const normal = normalizarLiteral(markdown.replace(/\r\n/g, '\n'))

  for (const linea of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const respuesta = /^\s*(?:[-*]\s*)?\**R:\**\s*(.+)$/.exec(linea)
    if (respuesta) {
      const texto = sinComillasExternas(normalizarLiteral(respuesta[1]))
      if (texto.length >= LARGO_MINIMO && !esMarcador(texto)) citas.add(texto)
    }
  }
  for (const coincidencia of normal.matchAll(/"([^"]+)"/g)) {
    const texto = coincidencia[1].trim()
    if (texto.length >= LARGO_MINIMO && !esMarcador(texto)) citas.add(texto)
  }
  return [...citas]
}

/**
 * Separa los pedazos de una propuesta. Una respuesta puede estar repartida en el material (el
 * precio de cada producto en su bloque): se copia cada pedazo tal cual y se separan con esta
 * línea, así cada uno se verifica por su lado y no se pega nada que el dueño no escribió.
 */
export const SEPARADOR_FRAGMENTOS = '[…]'

export function fragmentosDePropuesta(texto: string): string[] {
  return texto
    .split(/\s*\[(?:…|\.\.\.)\]\s*/)
    .map((fragmento) => fragmento.trim())
    .filter(Boolean)
}

/** Las citas del markdown que no están, letra por letra, en la fuente. */
export function citasQueNoAparecen(markdown: string, fuente: string): string[] {
  const donde = normalizarLiteral(fuente)
  return citasDelMarkdown(markdown).filter((cita) => !donde.includes(cita))
}
