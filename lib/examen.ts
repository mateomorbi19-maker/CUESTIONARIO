/**
 * El cuestionario a medida que genera la skill `mi-negocio` (examen.md).
 *
 * La IA lo devuelve como JSON, así su estructura no depende de que el markdown salga
 * prolijo, y el markdown se arma acá con el formato exacto que define la skill. Las reglas de
 * la Fase 3 que no necesitan criterio las chequea este archivo: si fallan, se le devuelve la
 * lista a la IA para que lo corrija antes de mostrarle nada al cliente.
 */

export const TITULOS_SECCION = {
  0: 'Material a juntar antes de empezar',
  1: 'Qué ofrecés',
  2: 'A quién le servís, y a quién no',
  3: 'Cómo es el recorrido hoy',
  4: 'En qué termina una conversación buena',
  5: 'Preguntas que te hacen siempre',
  6: 'Trabas y resistencias',
  7: 'Qué hacés vos después',
  8: 'Qué no tiene que hacer el agente',
  9: 'Cómo escribís',
} as const

/** Secciones donde la respuesta es texto que el dueño le mandaría tal cual a un cliente. */
export const SECCIONES_TEXTO_LITERAL: readonly number[] = [5, 6, 9]

export const ARQUETIPOS = {
  A: 'Venta consultiva',
  B: 'Agendamiento',
  C: 'Pedido y catálogo',
  D: 'Filtro y derivación',
  E: 'Soporte',
} as const

export type LetraArquetipo = keyof typeof ARQUETIPOS

export const MINIMO_PREGUNTAS = 30
export const MAXIMO_PREGUNTAS = 45

export interface Pregunta {
  /** "3.2": sección y número. Es la clave con la que se guardan las respuestas. */
  id: string
  texto: string
}

export interface Seccion {
  numero: number
  titulo: string
  preguntas: Pregunta[]
}

export interface Examen {
  negocio: string
  arquetipo: LetraArquetipo
  accionTerminal: string
  /** Aviso honesto cuando el cuestionario salió general por falta de material real. */
  nota: string | null
  /** Sección 0: lo que el cliente tiene que juntar antes de empezar. */
  material: string[]
  /** Secciones 1 a 9, en orden. */
  secciones: Seccion[]
}

/** Lo que devuelve la IA. Los títulos y la numeración los pone el código, no el modelo. */
export interface SalidaExamen {
  negocio: string
  arquetipo: LetraArquetipo
  accion_terminal: string
  /** Vacío cuando no hace falta nota. */
  nota: string
  material: string[]
  secciones: { numero: number; preguntas: string[] }[]
}

function tituloDe(numero: number): string {
  return TITULOS_SECCION[numero as keyof typeof TITULOS_SECCION] ?? `Sección ${numero}`
}

/** El modelo a veces repite la numeración adentro del texto ("3.2. ¿Qué...?"). */
function sinNumeracion(texto: string): string {
  return texto.replace(/^\s*\d+\.\d+\.?\s*/, '').trim()
}

export function armarExamen(salida: SalidaExamen): Examen {
  return {
    negocio: salida.negocio.trim(),
    arquetipo: salida.arquetipo,
    accionTerminal: salida.accion_terminal.trim(),
    nota: salida.nota.trim() || null,
    material: salida.material.map((m) => m.trim()).filter(Boolean),
    secciones: [...salida.secciones]
      .sort((a, b) => a.numero - b.numero)
      .map((s) => ({
        numero: s.numero,
        titulo: tituloDe(s.numero),
        preguntas: s.preguntas.map((texto, i) => ({ id: `${s.numero}.${i + 1}`, texto: sinNumeracion(texto) })),
      })),
  }
}

export function examenAMarkdown(examen: Examen): string {
  const lineas = [
    `# Cuestionario — ${examen.negocio}`,
    `Arquetipo: ${examen.arquetipo} · ${ARQUETIPOS[examen.arquetipo]} · Acción terminal: ${examen.accionTerminal}`,
  ]
  if (examen.nota) lineas.push('', examen.nota)
  lineas.push('', `## 0. ${TITULOS_SECCION[0]}`, ...examen.material.map((m) => `- ${m}`))
  for (const seccion of examen.secciones) {
    lineas.push('', `## ${seccion.numero}. ${seccion.titulo}`, ...seccion.preguntas.map((p) => `${p.id}. ${p.texto}`))
  }
  return lineas.join('\n') + '\n'
}

const RE_TITULO = /^#\s*Cuestionario\s*[—–-]\s*(.+?)\s*$/
const RE_SECCION = /^##\s*(\d+)\.\s*(.+?)\s*$/
const RE_PREGUNTA = /^\s*(\d+)\.(\d+)\.\s+(.*)$/
const RE_VINETA = /^\s*[-*]\s+(.*)$/
const RE_MATERIAL_NUMERADO = /^\s*0\.\d+\.\s+(.*)$/
const RE_LINEA_HORIZONTAL = /^(?:-{3,}|\*{3,}|_{3,})$/

/**
 * Lee un examen.md escrito a mano o por la skill en Claude Code.
 *
 * Existe para importar lo que ya se generó fuera de la app (por ejemplo las salidas del
 * harness) y pasarlo por las mismas reglas. Las líneas que no entiende no se descartan en
 * silencio: van a `problemas`. Lo que el modelo agrega después de una línea horizontal al
 * final ("Son 44 preguntas...") no es cuestionario y va a `ignorado`.
 */
export function leerExamenMarkdown(md: string): { examen: Examen | null; problemas: string[]; ignorado: string[] } {
  const problemas: string[] = []
  const ignorado: string[] = []
  let fueraDelExamen = false
  let negocio: string | null = null
  let arquetipo: LetraArquetipo | null = null
  let accionTerminal: string | null = null
  const nota: string[] = []
  const material: string[] = []
  const secciones: Seccion[] = []

  // null mientras se está en el encabezado, antes de la primera sección.
  let seccionActual: number | null = null
  // Lo último que se abrió, para pegarle las líneas que continúan el mismo ítem.
  let abierto: { tipo: 'material' } | { tipo: 'pregunta'; pregunta: Pregunta } | null = null

  for (const cruda of md.replace(/\r\n/g, '\n').split('\n')) {
    const sinEspacios = cruda.trim()
    if (!sinEspacios) {
      abierto = null
      continue
    }

    if (RE_LINEA_HORIZONTAL.test(sinEspacios) && secciones.length > 0) {
      fueraDelExamen = true
      continue
    }
    if (fueraDelExamen) {
      ignorado.push(sinEspacios)
      continue
    }

    // Sin negritas: el modelo a veces marca así el arquetipo o la numeración.
    const linea = sinEspacios.replace(/\*\*|__/g, '').trim()

    const titulo = RE_TITULO.exec(linea)
    if (titulo && negocio === null) {
      negocio = titulo[1]
      continue
    }

    if (/^Arquetipo:/i.test(linea)) {
      const partes = linea.split('·').map((p) => p.trim())
      const letra = /^Arquetipo:\s*([A-E])\b/i.exec(partes[0])?.[1]?.toUpperCase()
      const desde = partes.findIndex((p) => /^Acci[oó]n terminal:/i.test(p))
      if (letra && letra in ARQUETIPOS) arquetipo = letra as LetraArquetipo
      else problemas.push(`No se entiende el arquetipo en: "${linea}"`)
      if (desde >= 0) accionTerminal = partes.slice(desde).join(' · ').replace(/^Acci[oó]n terminal:\s*/i, '')
      else problemas.push(`Falta la acción terminal en: "${linea}"`)
      continue
    }

    const seccion = RE_SECCION.exec(linea)
    if (seccion) {
      seccionActual = Number(seccion[1])
      abierto = null
      if (seccionActual !== 0) secciones.push({ numero: seccionActual, titulo: seccion[2], preguntas: [] })
      continue
    }

    if (seccionActual === null) {
      nota.push(linea)
      continue
    }

    if (seccionActual === 0) {
      // El material va en viñetas, pero a veces el modelo lo numera como preguntas (0.1., 0.2.).
      const item = RE_VINETA.exec(linea) ?? RE_MATERIAL_NUMERADO.exec(linea)
      if (item) {
        material.push(item[1].trim())
        abierto = { tipo: 'material' }
      } else if (abierto?.tipo === 'material') {
        material[material.length - 1] += ` ${linea}`
      } else {
        problemas.push(`Línea suelta en la sección 0: "${linea}"`)
        material.push(linea)
      }
      continue
    }

    const pregunta = RE_PREGUNTA.exec(linea)
    if (pregunta) {
      const [, numeroSeccion, numeroPregunta, texto] = pregunta
      if (Number(numeroSeccion) !== seccionActual) {
        problemas.push(`La pregunta ${numeroSeccion}.${numeroPregunta} está dentro de la sección ${seccionActual}.`)
      }
      const nueva = { id: `${numeroSeccion}.${numeroPregunta}`, texto: texto.trim() }
      secciones[secciones.length - 1].preguntas.push(nueva)
      abierto = { tipo: 'pregunta', pregunta: nueva }
    } else if (abierto?.tipo === 'pregunta') {
      abierto.pregunta.texto += ` ${linea}`
    } else {
      problemas.push(`Línea que no es una pregunta en la sección ${seccionActual}: "${linea}"`)
    }
  }

  if (negocio === null) problemas.push('Falta el título "# Cuestionario — [negocio]".')
  if (arquetipo === null && accionTerminal === null) problemas.push('Falta la línea "Arquetipo: ... · Acción terminal: ...".')

  const examen =
    negocio !== null && arquetipo !== null && accionTerminal !== null
      ? { negocio, arquetipo, accionTerminal, nota: nota.length ? nota.join(' ') : null, material, secciones }
      : null
  return { examen, problemas, ignorado }
}

/*
 * Verbos que piden narración. \b de JavaScript no reconoce el límite de palabra después de
 * una vocal acentuada, así que se usa un lookahead de espacio o puntuación. De paso,
 * "Contaste que..." no se marca: no es el verbo.
 */
const RE_VERBO_NARRACION =
  /^\s*(?:(?:Cont[aá]|Describ[ií]|Explic[aá]|Coment[aá])(?=[\s,:;.]|$)|¿\s*C[oó]mo\s+(?:manej[aá]s|hac[eé]s\s+para))/i
const RE_APERTURA_LITERAL = /^\s*(?:Peg[aá]|Escrib[ií]\s+tal\s+cual|Copi[aá])(?=[\s,:;.]|$)/i
// Límites Unicode para que "funcionamiento" no cuente como "función".
const RE_PALABRAS_PROHIBIDAS = /(?<!\p{L})(?:herramientas?|funci[oó]n(?:es)?|prompts?)(?!\p{L})/giu
const RE_SIGUE_HACIENDO = /seguir\s+haciendo/i

function recortar(texto: string, largo = 90): string {
  return texto.length > largo ? `${texto.slice(0, largo - 1)}…` : texto
}

export interface ResultadoValidacion {
  /** Rompen una regla de la skill: el examen no se usa hasta corregirlo. */
  errores: string[]
  /** Conviene revisarlos, pero no frenan. */
  avisos: string[]
  cantidadPreguntas: number
}

export function validarExamen(examen: Examen): ResultadoValidacion {
  const errores: string[] = []
  const avisos: string[] = []

  const numeros = examen.secciones.map((s) => s.numero)
  for (let n = 1; n <= 9; n++) {
    const veces = numeros.filter((x) => x === n).length
    if (veces === 0) errores.push(`Falta la sección ${n} (${tituloDe(n)}). Las nueve secciones van siempre.`)
    if (veces > 1) errores.push(`La sección ${n} aparece ${veces} veces.`)
  }
  const sobrantes = [...new Set(numeros.filter((n) => n < 1 || n > 9))]
  if (sobrantes.length) errores.push(`Hay secciones que no existen en la estructura: ${sobrantes.join(', ')}.`)

  for (const seccion of examen.secciones) {
    if (seccion.preguntas.length === 0) {
      errores.push(`La sección ${seccion.numero} no tiene preguntas. Ninguna sección se saltea: si algo no aplica, lo contesta el cliente con NO APLICA.`)
    }
    seccion.preguntas.forEach((p, i) => {
      const esperado = `${seccion.numero}.${i + 1}`
      if (p.id !== esperado) errores.push(`La pregunta ${p.id} tendría que numerarse ${esperado}.`)
    })
  }

  const preguntas = examen.secciones.flatMap((s) => s.preguntas.map((p) => ({ ...p, seccion: s.numero })))
  const cantidad = preguntas.length
  if (cantidad > MAXIMO_PREGUNTAS) {
    errores.push(
      `Tiene ${cantidad} preguntas y el techo es ${MAXIMO_PREGUNTAS}. Recortá de la sección más cargada, empezando por las que piden un dato que ya se pidió en otra sección.`,
    )
  } else if (cantidad < MINIMO_PREGUNTAS) {
    errores.push(`Tiene ${cantidad} preguntas y el mínimo es ${MINIMO_PREGUNTAS}: no alcanza para cubrir los cinco campos universales.`)
  }

  for (const p of preguntas) {
    if (!p.texto.trim()) {
      errores.push(`La pregunta ${p.id} está vacía.`)
      continue
    }
    if (RE_VERBO_NARRACION.test(p.texto)) {
      errores.push(`La pregunta ${p.id} abre con un verbo que pide narración: "${recortar(p.texto)}". Cambiala por un pedido de dato o de texto literal.`)
    }
    if (SECCIONES_TEXTO_LITERAL.includes(p.seccion) && !RE_APERTURA_LITERAL.test(p.texto)) {
      avisos.push(`La pregunta ${p.id} es de una sección de texto literal y no abre con "Pegá" o "Escribí tal cual": "${recortar(p.texto)}".`)
    }
  }

  const visibles = [examen.accionTerminal, examen.nota ?? '', ...examen.material, ...preguntas.map((p) => p.texto)]
  const prohibidas = new Set(visibles.flatMap((t) => [...t.matchAll(RE_PALABRAS_PROHIBIDAS)].map((m) => m[0].toLowerCase())))
  if (prohibidas.size) {
    errores.push(`Aparecen palabras que el cuestionario no puede usar: ${[...prohibidas].join(', ')}. La sección 7 pregunta qué hace la persona, en infinitivo.`)
  }

  const octava = examen.secciones.find((s) => s.numero === 8)
  if (octava) {
    if (!octava.preguntas.some((p) => RE_SIGUE_HACIENDO.test(p.texto))) {
      errores.push('Falta en la sección 8: "¿Qué parte de atender un chat vas a seguir haciendo vos aunque el agente esté andando? Nombrala."')
    }
    if (!octava.preguntas.some((p) => /nunca/i.test(p.texto) && /menci[oó]n/i.test(p.texto))) {
      errores.push('Falta en la sección 8: "¿Hay algo que no querés que se mencione nunca por chat? Escribilo."')
    }
  }

  if (examen.material.length < 3) {
    avisos.push(`La sección 0 pide ${examen.material.length} cosa(s): tendría que pedir al menos las tres conversaciones adaptadas al arquetipo.`)
  }

  const vistas = new Map<string, string>()
  for (const p of preguntas) {
    const clave = p.texto.toLowerCase().replace(/\s+/g, ' ').trim()
    const anterior = vistas.get(clave)
    if (anterior) avisos.push(`Las preguntas ${anterior} y ${p.id} dicen lo mismo.`)
    else vistas.set(clave, p.id)
  }

  return { errores, avisos, cantidadPreguntas: cantidad }
}
