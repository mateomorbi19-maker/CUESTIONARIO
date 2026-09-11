/**
 * Simulador: dueños de negocio inventados completan el cuestionario contra el motor real y
 * Claude real. Sirve para ver qué genera la app antes de mandarle el link a un cliente.
 *
 *   npm run simular -- clinica                   hasta el cuestionario generado (barato)
 *   npm run simular -- clinica --completo        hasta los entregables (unos dólares)
 *   npm run simular -- --personas pruebas/privadas/cliente.json --completo
 *
 * Una persona puede traer "material" (textos) o "material_archivos" (rutas a archivos de texto)
 * que se pegan tal cual en la etapa de material; por ejemplo, el guion escrito de un cliente
 * real. Si no trae, la persona inventa uno.
 *
 * Necesita ANTHROPIC_API_KEY en .env. Empezá siempre por una sola persona.
 * Deja en pruebas/salidas/<id>/ la transcripción, las llamadas y los archivos generados, también
 * cuando la corrida falla a mitad de camino.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clienteClaude, type ClienteIa, type RegistroLlamada } from '../lib/claude'
import { costoEstimado } from '../lib/costos'
import { examenAMarkdown, validarExamen } from '../lib/examen'
import { avanzar, estadoInicial, pantallaActual, type Dependencias } from '../lib/motor/motor'
import type { Entrada, EstadoCuestionario, Pantalla } from '../lib/motor/tipos'
import { leerPlantillaClaude, leerSkill } from '../lib/skills'

interface Persona {
  id: string
  negocio: string
  arquetipo_esperado: string
  accion_terminal_esperada: string
  prueba: string
  caracter: string
  hechos: string[]
  material?: string[]
  material_archivos?: string[]
}

interface Turno {
  quien: 'formulario' | 'dueño'
  texto: string
}

const MODELO_PERSONA = process.env.MODELO_PERSONA || 'claude-sonnet-5'

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
- Si te preguntan un dato que tu personaje no tendría, decí que no lo sabés o usá "no_se". No inventes números.
- Nunca salgas del personaje ni ayudes a quien pregunta a hacer mejor su trabajo.

Qué devolvés según la pantalla (solo podés usar los tipos que la pantalla permite):
- Una pregunta: tipo "respuesta" y en "texto" tu respuesta. Si no lo sabés, "no_se". Si no corresponde a tu negocio, "no_aplica" y en "texto" el motivo.
- Te piden pegar un chat: si guardás los chats, "respuesta" con un chat creíble de tu negocio que terminó bien, escrito como diálogo. Si no los guardás, "sin_chat".
- Te hacen elegir entre dos procesos: "eleccion" y en "texto" copiá exacta la opción que elegís.
- Te muestran cómo entendieron tu negocio: si es así, "confirmar"; si no, "corregir" y en "texto" qué es distinto.
- Te piden juntar material: si todavía no pegaste nada y guardás chats, "texto_material" con UNA conversación creíble de tu negocio. Cuando ya pegaste lo que tenés (máximo tres), "terminar_material". Si no guardás chats, directamente "terminar_material".
- Te muestran lo que decía tu material: si sigue siendo así, "sigue_igual"; si cambió, "respuesta" con cómo es ahora.`
}

/** Los tipos de entrada que acepta cada pantalla: la persona no puede elegir otros. */
function tiposPermitidos(pantalla: Pantalla): Entrada['tipo'][] {
  switch (pantalla.tipo) {
    case 'pregunta':
      return ['respuesta']
    case 'pedido_chat':
      return ['respuesta', 'sin_chat']
    case 'eleccion':
      return ['eleccion']
    case 'confirmacion':
      return ['confirmar', 'corregir']
    case 'material':
      return ['texto_material', 'terminar_material']
    case 'entrevista':
      return pantalla.propuesta && !pantalla.repregunta ? ['sigue_igual', 'respuesta', 'no_se', 'no_aplica'] : ['respuesta', 'no_se', 'no_aplica']
    case 'pregunta_final':
      return ['respuesta', 'no_se']
    case 'gracias':
      return []
  }
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
      return `Antes de seguir, juntá esto:\n${pantalla.items.map((i) => `- ${i}`).join('\n')}\nYa pegaste ${pantalla.textos.length} texto(s).${pantalla.aviso ? `\nAviso: ${pantalla.aviso}` : ''}`
    case 'entrevista': {
      const propuesta = pantalla.propuesta ? `\nEn lo que subiste dice: "${pantalla.propuesta.texto}"\n[Botones: "Sigue así" / "Cambió"]` : ''
      const repregunta = pantalla.repregunta ? `\nRepregunta: ${pantalla.repregunta}` : ''
      return `Sección ${pantalla.seccion.numero} de 9 · ${pantalla.seccion.titulo}\n${pantalla.pregunta.id}. ${pantalla.pregunta.texto}${propuesta}${repregunta}`
    }
    case 'pregunta_final':
      return `Últimas preguntas · ${pantalla.numero} de ${pantalla.total}\n${pantalla.texto}`
    case 'gracias':
      return pantalla.texto
  }
}

function describirEntrada(entrada: Entrada): string {
  switch (entrada.tipo) {
    case 'respuesta':
      return entrada.texto
    case 'corregir':
      return `[Corrige] ${entrada.texto}`
    case 'texto_material':
      return `[Pega material] ${entrada.texto}`
    case 'no_aplica':
      return `[No aplica] ${entrada.texto}`
    case 'eleccion':
      return `[Elige] ${entrada.opcion}`
    case 'quitar_texto':
      return '[Quita un texto]'
    default:
      return `[${entrada.tipo}]`
  }
}

async function responderComoPersona(persona: Persona, pantalla: Pantalla, historia: Turno[], ia: ClienteIa): Promise<Entrada> {
  // Los últimos turnos alcanzan para mantener coherencia sin mandar la entrevista entera cada vez.
  const pasado = historia.length
    ? `Lo último que pasó en el formulario:\n\n${historia.slice(-16).map((t) => `${t.quien === 'formulario' ? 'Formulario' : 'Vos'}: ${t.texto}`).join('\n\n')}\n\n`
    : ''
  const permitidos = tiposPermitidos(pantalla)
  const salida = await ia.pedirJson<{ tipo: Entrada['tipo']; texto: string }>({
    paso: 'persona',
    sistema: [sistemaDePersona(persona)],
    mensaje: `${pasado}Pantalla actual:\n\n${describirPantalla(pantalla)}\n\nTipos que acepta esta pantalla: ${permitidos.join(', ')}.`,
    esquema: {
      type: 'object',
      additionalProperties: false,
      required: ['tipo', 'texto'],
      properties: { tipo: { type: 'string', enum: permitidos }, texto: { type: 'string' } },
    },
    // La persona contesta decenas de veces con el mismo sistema: acá la caché sí rinde.
    cache: '5m',
    esfuerzo: 'low',
    maxTokens: 4000,
  })

  switch (salida.tipo) {
    case 'eleccion': {
      const opciones = pantalla.tipo === 'eleccion' ? pantalla.opciones : []
      const elegida = salida.texto.trim()
      const opcion = opciones.find((o) => o === elegida) ?? opciones.find((o) => o.includes(elegida) || elegida.includes(o)) ?? opciones[0]
      return { tipo: 'eleccion', opcion }
    }
    case 'respuesta':
    case 'corregir':
    case 'texto_material':
    case 'no_aplica':
      // Un texto vacío lo rechazaría la pantalla: se reemplaza por "no sé" o por lo mínimo que acepta.
      if (!salida.texto.trim()) return salida.tipo === 'respuesta' && permitidos.includes('no_se') ? { tipo: 'no_se' } : { tipo: salida.tipo, texto: 'No sé.' }
      return { tipo: salida.tipo, texto: salida.texto }
    default:
      return { tipo: salida.tipo } as Entrada
  }
}

interface Corrida {
  estado: EstadoCuestionario
  historia: Turno[]
  registros: RegistroLlamada[]
  error: string | null
}

async function simular(persona: Persona, completo: boolean): Promise<Corrida> {
  const registros: RegistroLlamada[] = []
  const iaMotor = clienteClaude((r) => {
    registros.push(r)
  })
  const iaPersona = clienteClaude(() => {}, MODELO_PERSONA)
  const dep: Dependencias = {
    ia: iaMotor,
    skill: leerSkill,
    plantillaClaude: leerPlantillaClaude,
    leerArchivo: async () => {
      throw new Error('El simulador no sube archivos: el material va como texto pegado.')
    },
  }
  const historia: Turno[] = []
  const pendientesDeMaterial = [...(persona.material ?? [])]
  let estado: EstadoCuestionario = estadoInicial(persona.negocio)
  const fin = completo ? 'terminado' : 'material'
  const turnosMaximos = completo ? 220 : 40

  try {
    for (let turno = 1; estado.etapa !== fin; turno++) {
      if (turno > turnosMaximos) throw new Error(`Pasaron ${turnosMaximos} turnos sin llegar a "${fin}".`)
      const pantalla = pantallaActual(estado)

      // Material fijo de la persona (por ejemplo, el guion real de un cliente): se pega tal cual.
      const entrada: Entrada =
        pantalla.tipo === 'material' && persona.material
          ? pendientesDeMaterial.length
            ? { tipo: 'texto_material', texto: pendientesDeMaterial.shift()! }
            : { tipo: 'terminar_material' }
          : await responderComoPersona(persona, pantalla, historia, iaPersona)

      historia.push({ quien: 'formulario', texto: describirPantalla(pantalla) }, { quien: 'dueño', texto: describirEntrada(entrada) })
      estado = await avanzar(estado, entrada, dep)
      if (turno % 10 === 0) process.stdout.write(`${turno}… `)
    }
    return { estado, historia, registros, error: null }
  } catch (err) {
    return { estado, historia, registros, error: err instanceof Error ? err.message : String(err) }
  }
}

function transcripcionMarkdown(persona: Persona, corrida: Corrida): string {
  const { estado, historia, error } = corrida
  const cuerpo = historia.map((t) => `**${t.quien === 'formulario' ? 'Formulario' : persona.negocio}:**\n\n${t.texto}`).join('\n\n---\n\n')
  const avisos = [...estado.pendientesExamen, ...estado.avisos]
  return `# Transcripción — ${persona.negocio}

Arquetipo esperado: ${persona.arquetipo_esperado} · Obtenido: ${estado.clasificacion?.arquetipo ?? '-'}
Acción terminal esperada: ${persona.accion_terminal_esperada} · Obtenida: ${estado.clasificacion?.accionTerminal ?? '-'}
Qué prueba este caso: ${persona.prueba}
Etapa final: ${estado.etapa}${error ? `\n\nFALLÓ: ${error}` : ''}${avisos.length ? `\n\nAvisos:\n${avisos.map((a) => `- ${a}`).join('\n')}` : ''}

---

${cuerpo}
`
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY. Copiá .env.example a .env y pegá ahí tu clave de Anthropic.')
    process.exit(1)
  }

  const argumentos = process.argv.slice(2)
  const completo = argumentos.includes('--completo')
  const indicePersonas = argumentos.indexOf('--personas')
  const archivo = indicePersonas >= 0 ? argumentos[indicePersonas + 1] : join('pruebas', 'personas.json')
  // El valor que sigue a --personas es la ruta del archivo, no el filtro.
  const filtro = argumentos.find((a, i) => !a.startsWith('--') && (indicePersonas < 0 || i !== indicePersonas + 1))

  const personas: Persona[] = JSON.parse(await readFile(archivo, 'utf8'))
  for (const persona of personas) {
    // Un guion entero no entra cómodo adentro de un JSON: puede venir en archivos aparte.
    for (const ruta of persona.material_archivos ?? []) (persona.material ??= []).push(await readFile(ruta, 'utf8'))
  }
  const elegidas = filtro ? personas.filter((p) => p.id.includes(filtro)) : personas
  if (!elegidas.length) {
    console.error(`No hay ninguna persona en ${archivo} cuyo id contenga "${filtro}".`)
    process.exit(1)
  }

  console.log(`Simulando ${elegidas.length} persona(s) ${completo ? 'de punta a punta' : 'hasta el cuestionario'}. Motor: ${clienteClaude().modelo} · Persona: ${MODELO_PERSONA}\n`)
  const resumen: Record<string, unknown>[] = []

  for (const persona of elegidas) {
    const carpeta = join('pruebas', 'salidas', persona.id)
    await mkdir(carpeta, { recursive: true })
    process.stdout.write(`  ${persona.id} ... `)
    const inicio = Date.now()

    const corrida = await simular(persona, completo)
    const { estado, registros, error } = corrida
    if (estado.examen) await writeFile(join(carpeta, 'examen.md'), examenAMarkdown(estado.examen))
    if (estado.entregables) {
      await writeFile(join(carpeta, 'brief-comercial.md'), estado.entregables.brief)
      await writeFile(join(carpeta, 'CLAUDE.md'), estado.entregables.claude)
      await writeFile(join(carpeta, 'cierre.md'), estado.entregables.cierre)
    }
    await writeFile(join(carpeta, 'transcripcion.md'), transcripcionMarkdown(persona, corrida))
    await writeFile(join(carpeta, 'llamadas.json'), JSON.stringify(registros, null, 2))
    await writeFile(join(carpeta, 'estado.json'), JSON.stringify(estado, null, 2))

    const validacion = estado.examen ? validarExamen(estado.examen) : null
    const respuestas = Object.values(estado.entrevista.respuestas)
    const fila = {
      id: persona.id,
      etapa: estado.etapa,
      obtenido: estado.clasificacion?.arquetipo ?? '-',
      preguntas: validacion?.cantidadPreguntas ?? 0,
      respondidas: respuestas.length,
      pendientes: respuestas.filter((r) => r.estado === 'pendiente').length,
      propuestas: Object.keys(estado.entrevista.propuestas).length,
      finales: estado.preguntasFinales.length,
      avisos: estado.avisos.length,
      llamadas: registros.length,
      usd: Number(costoEstimado(registros).toFixed(2)),
      min: Number(((Date.now() - inicio) / 60_000).toFixed(1)),
      error,
    }
    resumen.push(fila)
    console.log(error ? `FALLÓ en ${estado.etapa} · ${error}` : `ok · ${fila.respondidas} respuestas · ${fila.pendientes} pendientes · US$ ${fila.usd} · ${fila.min} min`)
  }

  await writeFile(join('pruebas', 'salidas', 'resumen.json'), JSON.stringify(resumen, null, 2))
  console.log('\n--- Resumen ---')
  console.table(resumen.map(({ error: _error, ...resto }) => resto))
  console.log('\nLos archivos están en pruebas/salidas/<id>/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
