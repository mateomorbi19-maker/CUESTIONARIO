import { ARQUETIPOS } from './examen'
import { enviarCorreo, faltaParaCorreo } from './correo'
import { costoEstimado } from './costos'
import { avisosPendientes, buscarPorId, consumoDe, marcarAviso, type Cuestionario } from './cuestionarios'

/**
 * Los mails de la app: el link personal al cliente y el aviso con los entregables a Mateo.
 *
 * Ninguno puede frenar el cuestionario. Si el aviso final falla, queda anotado y se reintenta
 * solo cada diez minutos (ver instrumentation.ts), hasta cinco veces.
 */

const MAXIMO_INTENTOS_AVISO = 5
const MINUTOS_ENTRE_REINTENTOS = 10

function urlPublica(): string | null {
  const url = process.env.URL_PUBLICA?.trim().replace(/\/+$/, '')
  return url || null
}

export async function mandarLinkAlCliente(email: string, negocio: string, token: string): Promise<void> {
  const base = urlPublica()
  // Sin correo o sin URL pública no hay link que mandar: el cliente igual lo tiene en pantalla.
  if (faltaParaCorreo() || !base) return
  await enviarCorreo({
    para: email,
    asunto: `Tu cuestionario — ${negocio}`,
    cuerpo: `Hola.

Este es tu link para completar el cuestionario de ${negocio}:
${base}/c/${token}

Podés cortar cuando quieras: se guarda todo y seguís desde el mismo link.
`,
  })
}

function cuerpoDelAviso(cuestionario: Cuestionario, costo: number, llamadas: number): string {
  const { estado } = cuestionario
  const c = estado.clasificacion
  const respuestas = Object.values(estado.entrevista.respuestas)
  const contar = (e: string) => respuestas.filter((r) => r.estado === e).length
  const base = urlPublica()

  return `Terminó el cuestionario de ${cuestionario.negocio}.

Contacto: ${cuestionario.email}
Arquetipo: ${c ? `${c.arquetipo} · ${ARQUETIPOS[c.arquetipo]}` : '-'}
Acción terminal: ${c?.accionTerminal ?? '-'}${estado.procesoElegido ? `\nProceso elegido: ${estado.procesoElegido}` : ''}
Respuestas: ${contar('completa')} completas, ${contar('pendiente')} pendientes, ${contar('no_aplica')} no aplican
Contradicciones: ${estado.cierre?.contradicciones.length ?? 0}
Preguntas finales: ${estado.preguntasFinales.length}
Costo aproximado en Claude: US$ ${costo.toFixed(2)} (${llamadas} llamadas)

Adjuntos:
- examen.md: el cuestionario a medida que contestó.
- brief-comercial.md: su proceso comercial documentado.
- CLAUDE.md: la plantilla del starter kit completa.
- cierre.md: lo que el cliente no ve (lo que contestó distinto de su material, contradicciones, simulaciones, pendientes).

Para seguir: copiá examen.md, brief-comercial.md y CLAUDE.md a la carpeta del agente y corré /etapas.
${base ? `\nCuestionario: ${cuestionario.id}` : ''}
`
}

/** Manda el aviso con los entregables. No tira errores: los deja anotados para reintentar. */
export async function avisarTerminado(cuestionario: Cuestionario): Promise<void> {
  const entregables = cuestionario.estado.entregables
  if (!entregables || cuestionario.avisoEnviadoEn) return

  const destino = process.env.MAIL_AVISO?.trim()
  const falta = !destino ? 'Falta MAIL_AVISO: no hay a quién mandarle el aviso.' : faltaParaCorreo()
  if (falta) {
    console.error(`[aviso ${cuestionario.id}] ${falta}`)
    await marcarAviso(cuestionario.id, falta)
    return
  }

  try {
    const consumo = await consumoDe(cuestionario.id)
    const tipo = 'text/markdown; charset=UTF-8'
    await enviarCorreo({
      para: destino!,
      asunto: `Cuestionario terminado — ${cuestionario.negocio}`,
      cuerpo: cuerpoDelAviso(cuestionario, costoEstimado(consumo), consumo.length),
      adjuntos: [
        { nombre: 'examen.md', tipo, contenido: entregables.examen },
        { nombre: 'brief-comercial.md', tipo, contenido: entregables.brief },
        { nombre: 'CLAUDE.md', tipo, contenido: entregables.claude },
        { nombre: 'cierre.md', tipo, contenido: entregables.cierre },
      ],
    })
    await marcarAviso(cuestionario.id, null)
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err)
    console.error(`[aviso ${cuestionario.id}] no se pudo mandar:`, detalle)
    await marcarAviso(cuestionario.id, detalle).catch(() => undefined)
  }
}

export async function reintentarAvisos(): Promise<void> {
  for (const id of await avisosPendientes(MAXIMO_INTENTOS_AVISO)) {
    const cuestionario = await buscarPorId(id)
    if (cuestionario) await avisarTerminado(cuestionario)
  }
}

const globalAvisos = globalThis as unknown as { _reintentosAvisos?: NodeJS.Timeout }

/** Arranca una sola vez por proceso, desde instrumentation.ts. */
export function iniciarReintentosDeAvisos(): void {
  if (globalAvisos._reintentosAvisos) return
  const correr = () => {
    reintentarAvisos().catch((err) => console.error('[avisos] falló el reintento de avisos:', err))
  }
  globalAvisos._reintentosAvisos = setInterval(correr, MINUTOS_ENTRE_REINTENTOS * 60_000)
  // Que el temporizador no mantenga vivo el proceso cuando Next quiere cerrarlo.
  globalAvisos._reintentosAvisos.unref()
}
