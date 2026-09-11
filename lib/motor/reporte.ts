import { ARQUETIPOS, examenAMarkdown } from '../examen'
import type { EstadoCuestionario } from './tipos'

/**
 * cierre.md: lo que el dueño no ve y a Mateo le sirve para construir el agente.
 *
 * Lo arma el código a partir del estado, no la IA: son datos que ya están, y así el reporte no
 * puede omitir nada ni suavizar una contradicción.
 */
export function armarReporteCierre(estado: EstadoCuestionario, pendientes: string[]): string {
  const c = estado.clasificacion
  const secciones = estado.examen?.secciones ?? []
  const preguntas = secciones.flatMap((s) => s.preguntas)
  const respuestas = estado.entrevista.respuestas
  const contar = (e: string) => Object.values(respuestas).filter((r) => r.estado === e).length

  const partes: string[] = [`# Cierre — ${estado.negocio}`, '', 'Lo que el dueño no ve. Sale del cierre interno de la entrevista.', '']

  const archivos = estado.material.archivos.filter((a) => a.etapa === 'material')
  partes.push(
    '## Resumen',
    '',
    `- Arquetipo: ${c ? `${c.arquetipo} · ${ARQUETIPOS[c.arquetipo]}` : 'sin clasificar'}`,
    `- Acción terminal: ${c?.accionTerminal ?? '-'}`,
    ...(estado.procesoElegido ? [`- Proceso elegido: ${estado.procesoElegido}`] : []),
    `- Material: ${archivos.length} archivo(s), ${estado.material.textos.length} texto(s) pegado(s)${estado.chat ? ', chat del principio' : ''}${estado.reconstruccion.length ? ', último chat reconstruido de memoria' : ''}`,
    `- Respuestas: ${contar('completa')} completas, ${contar('pendiente')} pendientes, ${contar('no_aplica')} no aplican (de ${preguntas.length} preguntas)`,
    '',
  )

  const conPropuesta = preguntas.filter((p) => respuestas[p.id]?.propuesta)
  const cambiaron = conPropuesta.filter((p) => !respuestas[p.id].sigueIgual && respuestas[p.id].estado === 'completa')
  const iguales = conPropuesta.filter((p) => respuestas[p.id].sigueIgual)
  // No confirmar una propuesta puede ser un cambio real en cómo vende o un fragmento que no
  // contestaba la pregunta. El código no puede saber cuál: el título no afirma ninguna de las dos.
  partes.push('## Lo que contestó distinto de su material', '')
  if (!conPropuesta.length) {
    partes.push('No había material escrito que contestara preguntas del cuestionario.', '')
  } else if (!cambiaron.length) {
    partes.push('Nada: todo lo que se le mostró de su material lo confirmó como sigue.', '')
  } else {
    partes.push(
      'Se le mostró un fragmento de lo que subió y no lo confirmó. Puede ser un cambio en cómo vende hoy o que el fragmento no contestaba la pregunta: revisalo antes de tocar el agente.',
      '',
    )
    for (const p of cambiaron) {
      const r = respuestas[p.id]
      const contesto = r.intercambios.at(-1)?.respuesta ?? ''
      partes.push(`**${p.id}. ${p.texto}**`, `- Su material (${r.propuesta!.fuente}): "${r.propuesta!.texto}"`, `- Contestó: "${contesto}"`, '')
    }
  }
  if (iguales.length) {
    partes.push('Confirmado sin cambios:', ...iguales.map((p) => `- ${p.id}. ${p.texto}`), '')
  }

  const planes = preguntas.filter((p) => respuestas[p.id]?.esPlan)
  partes.push('## Planes, no práctica', '')
  partes.push(...(planes.length ? planes.map((p) => `- ${p.id}. ${p.texto} → "${respuestas[p.id].intercambios.at(-1)?.respuesta ?? ''}"`) : ['Ninguna respuesta sonó a plan.']), '')

  const cierre = estado.cierre
  partes.push('## Contradicciones', '')
  partes.push(...(cierre?.contradicciones.length ? cierre.contradicciones.map((x) => `- ${x.detalle}`) : ['No encontré nada que no cierre.']), '')

  // El análisis corre antes de las preguntas finales, que salen de él. Sin esta aclaración, un
  // campo "incompleto" que el dueño completó después parece un hueco del brief.
  partes.push(
    '## Cobertura',
    '',
    'Cobertura, simulaciones y huecos son de antes de las preguntas finales: lo que contestó ahí ya está en el brief.',
    '',
    '| Campo | Estado | Detalle |',
    '|---|---|---|',
  )
  partes.push(...(cierre?.cobertura ?? []).map((f) => `| ${f.campo} | ${f.estado} | ${f.detalle.replace(/\|/g, '/')} |`), '')

  partes.push('## Simulaciones', '')
  for (const s of cierre?.simulaciones ?? []) partes.push(`### ${s.titulo}`, '', s.conversacion.trim(), '')

  partes.push('## Huecos que aparecieron al simular', '')
  partes.push(...(cierre?.agujeros.length ? cierre.agujeros.map((a) => `- ${a.detalle}`) : ['Ninguno.']), '')

  partes.push('## Preguntas finales', '')
  if (estado.preguntasFinales.length) {
    for (const p of estado.preguntasFinales) partes.push(`- **${p.texto}** (${p.motivo})`, `  ${p.respuesta ?? '[sin respuesta]'}`)
    partes.push('')
  } else {
    partes.push('No hizo falta ninguna.', '')
  }

  partes.push('## Pendientes', '')
  partes.push(...(pendientes.length ? pendientes.map((p) => `- [ ] ${p}`) : ['Ninguno.']), '')

  const avisos = [...estado.pendientesExamen.map((e) => `Cuestionario: ${e}`), ...estado.avisos]
  if (avisos.length) partes.push('## Avisos', '', ...avisos.map((a) => `- ${a}`), '')

  if (estado.examen) partes.push('## Cuestionario que se usó', '', 'Va aparte en examen.md.', '')
  return partes.join('\n')
}

/** Por si hace falta el examen dentro del reporte en otro formato. */
export { examenAMarkdown }
