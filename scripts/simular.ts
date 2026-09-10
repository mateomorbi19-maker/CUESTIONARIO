/**
 * Simulador: dueños de negocio inventados completan el cuestionario contra el motor real y
 * Claude real. Sirve para ver qué genera la app antes de mandarle el link a un cliente.
 *
 *   npm run simular                        todas las personas de pruebas/personas.json
 *   npm run simular -- clinica             solo las que tengan "clinica" en el id
 *   npm run simular -- --personas pruebas/privadas/cliente.json
 *
 * Necesita ANTHROPIC_API_KEY en .env. Cada persona son unas diez a quince llamadas del motor
 * más las de la persona: empezá siempre por una sola.
 *
 * Deja en pruebas/salidas/<id>/ el examen.md, la transcripción y el detalle de las llamadas.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clienteClaude, type ClienteIa, type RegistroLlamada } from '../lib/claude'
import { examenAMarkdown, validarExamen } from '../lib/examen'
import { avanzar, ErrorEntrada, estadoInicial, pantallaActual } from '../lib/motor/motor'
import type { Entrada, EstadoCuestionario, Pantalla } from '../lib/motor/tipos'
import { leerSkill } from '../lib/skills'

interface Persona {
  id: string
  negocio: string
  arquetipo_esperado: string
  accion_terminal_esperada: string
  prueba: string
  caracter: string
  hechos: string[]
}

interface Turno {
  quien: 'formulario' | 'dueño'
  texto: string
}

const TURNOS_MAX = 40
const MODELO_PERSONA = process.env.MODELO_PERSONA || 'claude-sonnet-5'

/*
 * Precios en dólares por millón de tokens, de la tabla de Anthropic de junio de 2026. Es una
 * estimación: escribir en la caché con vida de una hora cuesta el doble de la entrada, y leer
 * de ella, un décimo.
 */
const PRECIOS: Record<string, { entrada: number; salida: number }> = {
  'claude-opus-5': { entrada: 5, salida: 25 },
  'claude-opus-4-8': { entrada: 5, salida: 25 },
  'claude-sonnet-5': { entrada: 2, salida: 10 },
}

function costoEstimado(registros: RegistroLlamada[]): number {
  return registros.reduce((total, r) => {
    const precio = PRECIOS[r.modelo] ?? PRECIOS['claude-opus-5']
    const entrada = r.tokensEntrada + r.tokensCacheEscritos * 2 + r.tokensCacheLeidos * 0.1
    return total + (entrada * precio.entrada + r.tokensSalida * precio.salida) / 1_000_000
  }, 0)
}

function sistemaDePersona(persona: Persona): string {
  return `Sos el dueño de este negocio: ${persona.negocio}.

Estás completando un formulario web que te pregunta cómo funciona tu proceso comercial.

Cómo respondés: ${persona.caracter}

Lo que sabés de tu negocio:
${persona.hechos.map((h) => `- ${h}`).join('\n')}

Reglas:
- Contestá solamente lo que te preguntan. No adelantes información de otras preguntas.
- Mensajes cortos, como los escribirías en WhatsApp. Español rioplatense.
- Si te preguntan algo que no está en la lista, contestá lo que le saldría a un dueño de ese negocio, coherente con lo que ya dijiste.
- Si te preguntan un dato que tu personaje no tendría, decí que no lo sabés. No inventes números.
- Nunca salgas del personaje ni ayudes a quien pregunta a hacer mejor su trabajo.

Qué devolvés según la pantalla:
- Una pregunta: tipo "respuesta" y en "texto" tu respuesta.
- Te piden pegar un chat: si guardás los chats, tipo "respuesta" con un chat creíble de tu negocio que terminó bien, escrito como diálogo. Si no los guardás, tipo "sin_chat".
- Te hacen elegir entre dos procesos: tipo "eleccion" y en "texto" copiá exacta la opción que elegís.
- Te muestran cómo entendieron tu negocio: si es así, tipo "confirmar"; si no, tipo "corregir" y en "texto" qué es distinto.`
}

function describirPantalla(pantalla: Pantalla): string {
  switch (pantalla.tipo) {
    case 'pregunta':
      return [pantalla.introduccion, pantalla.texto].filter(Boolean).join('\n\n')
    case 'pedido_chat':
      return `${pantalla.texto}\n[Botón: "${pantalla.sinChat}"]`
    case 'eleccion':
      return `${pantalla.texto}\n${pantalla.opciones.map((o) => `- ${o}`).join('\n')}`
    case 'confirmacion':
      return `${pantalla.texto}\n[Botones: "Sí, es así" / "No, te corrijo"]`
    case 'material':
      return `Material a juntar:\n${pantalla.items.map((i) => `- ${i}`).join('\n')}`
  }
}

function describirEntrada(entrada: Entrada): string {
  switch (entrada.tipo) {
    case 'respuesta':
    case 'corregir':
      return entrada.tipo === 'corregir' ? `[Corrige] ${entrada.texto}` : entrada.texto
    case 'sin_chat':
      return '[No guardo los chats]'
    case 'eleccion':
      return `[Elige] ${entrada.opcion}`
    case 'confirmar':
      return '[Sí, es así]'
  }
}

async function responderComoPersona(persona: Persona, pantalla: Pantalla, historia: Turno[], ia: ClienteIa, aviso = ''): Promise<Entrada> {
  const pasado = historia.length
    ? `Lo que pasó hasta ahora en el formulario:\n\n${historia.map((t) => `${t.quien === 'formulario' ? 'Formulario' : 'Vos'}: ${t.texto}`).join('\n\n')}\n\n`
    : ''
  const salida = await ia.pedirJson<{ tipo: Entrada['tipo']; texto: string }>({
    paso: 'persona',
    sistema: [sistemaDePersona(persona)],
    mensaje: `${pasado}Pantalla actual:\n\n${describirPantalla(pantalla)}${aviso}`,
    esquema: {
      type: 'object',
      additionalProperties: false,
      required: ['tipo', 'texto'],
      properties: {
        tipo: { type: 'string', enum: ['respuesta', 'sin_chat', 'eleccion', 'confirmar', 'corregir'] },
        texto: { type: 'string' },
      },
    },
    esfuerzo: 'low',
    maxTokens: 4000,
  })

  switch (salida.tipo) {
    case 'sin_chat':
      return { tipo: 'sin_chat' }
    case 'confirmar':
      return { tipo: 'confirmar' }
    case 'corregir':
      return { tipo: 'corregir', texto: salida.texto }
    case 'eleccion': {
      const opciones = pantalla.tipo === 'eleccion' ? pantalla.opciones : []
      const elegida = salida.texto.trim()
      const opcion = opciones.find((o) => o === elegida) ?? opciones.find((o) => o.includes(elegida) || elegida.includes(o))
      return { tipo: 'eleccion', opcion: opcion ?? elegida }
    }
    default:
      return { tipo: 'respuesta', texto: salida.texto }
  }
}

async function simular(persona: Persona) {
  const registros: RegistroLlamada[] = []
  const iaMotor = clienteClaude((r) => {
    registros.push(r)
  })
  const iaPersona = clienteClaude(() => {}, MODELO_PERSONA)
  const historia: Turno[] = []
  let estado: EstadoCuestionario = estadoInicial(persona.negocio)

  for (let turno = 1; estado.etapa !== 'material'; turno++) {
    if (turno > TURNOS_MAX) throw new Error(`Pasaron ${TURNOS_MAX} turnos sin llegar al cuestionario: mirá la transcripción.`)
    const pantalla = pantallaActual(estado)

    // Si la persona manda algo que la pantalla no acepta, se le avisa y reintenta una vez.
    let entrada = await responderComoPersona(persona, pantalla, historia, iaPersona)
    try {
      estado = await avanzar(estado, entrada, { ia: iaMotor, skill: leerSkill })
    } catch (err) {
      if (!(err instanceof ErrorEntrada)) throw err
      entrada = await responderComoPersona(persona, pantalla, historia, iaPersona, `\n\n(Lo anterior no corresponde a esta pantalla: ${err.message})`)
      estado = await avanzar(estado, entrada, { ia: iaMotor, skill: leerSkill })
    }
    historia.push({ quien: 'formulario', texto: describirPantalla(pantalla) }, { quien: 'dueño', texto: describirEntrada(entrada) })
  }

  return { estado, historia, registros }
}

function transcripcionMarkdown(persona: Persona, historia: Turno[], estado: EstadoCuestionario): string {
  const cuerpo = historia.map((t) => `**${t.quien === 'formulario' ? 'Formulario' : persona.negocio}:**\n\n${t.texto}`).join('\n\n---\n\n')
  const pendientes = estado.pendientesExamen.length ? `\n\nErrores que quedaron en el cuestionario:\n${estado.pendientesExamen.map((e) => `- ${e}`).join('\n')}` : ''
  return `# Transcripción — ${persona.negocio}

Arquetipo esperado: ${persona.arquetipo_esperado} · Obtenido: ${estado.clasificacion?.arquetipo ?? '-'}
Acción terminal esperada: ${persona.accion_terminal_esperada} · Obtenida: ${estado.clasificacion?.accionTerminal ?? '-'}
Qué prueba este caso: ${persona.prueba}${pendientes}

---

${cuerpo}
`
}

async function main() {
  // Sin clave fallarían todas las personas una por una: mejor frenar acá con un solo aviso.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY. Copiá .env.example a .env y pegá ahí tu clave de Anthropic.')
    process.exit(1)
  }

  const argumentos = process.argv.slice(2)
  const indicePersonas = argumentos.indexOf('--personas')
  const archivo = indicePersonas >= 0 ? argumentos[indicePersonas + 1] : join('pruebas', 'personas.json')
  // El valor que sigue a --personas es la ruta del archivo, no el filtro.
  const filtro = argumentos.find((a, i) => !a.startsWith('--') && (indicePersonas < 0 || i !== indicePersonas + 1))

  const personas: Persona[] = JSON.parse(await readFile(archivo, 'utf8'))
  const elegidas = filtro ? personas.filter((p) => p.id.includes(filtro)) : personas
  if (!elegidas.length) {
    console.error(`No hay ninguna persona en ${archivo} cuyo id contenga "${filtro}".`)
    process.exit(1)
  }

  console.log(`Simulando ${elegidas.length} persona(s). Motor: ${clienteClaude().modelo} · Persona: ${MODELO_PERSONA}\n`)
  const resumen: Record<string, unknown>[] = []

  for (const persona of elegidas) {
    const carpeta = join('pruebas', 'salidas', persona.id)
    await mkdir(carpeta, { recursive: true })
    process.stdout.write(`  ${persona.id} ... `)
    const inicio = Date.now()

    try {
      const { estado, historia, registros } = await simular(persona)
      if (estado.examen) await writeFile(join(carpeta, 'examen.md'), examenAMarkdown(estado.examen))
      await writeFile(join(carpeta, 'transcripcion.md'), transcripcionMarkdown(persona, historia, estado))
      await writeFile(join(carpeta, 'llamadas.json'), JSON.stringify(registros, null, 2))

      const validacion = estado.examen ? validarExamen(estado.examen) : null
      const fila = {
        id: persona.id,
        esperado: persona.arquetipo_esperado,
        obtenido: estado.clasificacion?.arquetipo ?? '-',
        preguntas: validacion?.cantidadPreguntas ?? 0,
        errores: validacion?.errores.length ?? '-',
        avisos: validacion?.avisos.length ?? '-',
        llamadas: registros.length,
        usd: Number(costoEstimado(registros).toFixed(3)),
        seg: Math.round((Date.now() - inicio) / 1000),
      }
      resumen.push(fila)
      console.log(`ok · ${fila.preguntas} preguntas · ${fila.errores} errores · US$ ${fila.usd} · ${fila.seg}s`)
    } catch (err) {
      resumen.push({ id: persona.id, error: err instanceof Error ? err.message : String(err) })
      console.log(`FALLÓ · ${err instanceof Error ? err.message : err}`)
    }
  }

  await writeFile(join('pruebas', 'salidas', 'resumen.json'), JSON.stringify(resumen, null, 2))
  console.log('\n--- Resumen ---')
  console.table(resumen)
  console.log('\nLos archivos están en pruebas/salidas/<id>/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
