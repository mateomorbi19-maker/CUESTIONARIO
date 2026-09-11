import { randomUUID } from 'node:crypto'
import { ErrorIa, type ClienteIa } from '../claude'
import { armarExamen, examenAMarkdown, SECCIONES_TEXTO_LITERAL, validarExamen, type Examen, type Seccion } from '../examen'
import type { NombreSkill } from '../skills'
import * as instrucciones from './instrucciones'
import { citasQueNoAparecen, fragmentosDePropuesta, normalizarLiteral, SEPARADOR_FRAGMENTOS } from './literal'
import { armarReporteCierre } from './reporte'
import * as textos from './textos'
import type {
  ArchivoMaterial,
  ArchivoPublico,
  Clasificacion,
  Entrada,
  EstadoCuestionario,
  Pantalla,
  RespuestaEntrevista,
} from './tipos'

/**
 * El recorrido del cuestionario: dado el estado guardado y lo que mandó la pantalla, calcula
 * el estado siguiente. No toca la base ni la red salvo a través de `Dependencias`, así se
 * puede probar entero con una IA falsa.
 */

export interface Dependencias {
  ia: ClienteIa
  /** El texto de una skill. En producción sale de skills/; en las pruebas se inyecta. */
  skill: (nombre: NombreSkill) => Promise<string>
  /** El contenido de un archivo subido, para transcribirlo. */
  leerArchivo: (archivo: ArchivoMaterial) => Promise<Buffer>
  /** La plantilla de CLAUDE.md del starter kit. */
  plantillaClaude: () => Promise<string>
}

/** La pantalla mandó algo que no corresponde a la etapa en la que está el cuestionario. */
export class ErrorEntrada extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErrorEntrada'
  }
}

/** Cuántas veces se le pide el examen a la IA mientras la validación encuentre errores. */
export const INTENTOS_EXAMEN = 3
/** Más preguntas al final cansan a quien ya contestó una hora: se priorizan las que más le sirven al agente. */
export const MAXIMO_PREGUNTAS_FINALES = 8
const TRANSCRIPCIONES_EN_PARALELO = 4

export function estadoInicial(negocio: string): EstadoCuestionario {
  return {
    etapa: 'triage',
    negocio,
    triage: { indice: 0, intercambios: [], repregunta: null },
    chat: null,
    reconstruccion: [],
    clasificacion: null,
    correcciones: [],
    procesoElegido: null,
    examen: null,
    pendientesExamen: [],
    material: { archivos: [], textos: [], avisoFaltantes: null },
    entrevista: { seccion: 1, indice: 0, repregunta: null, respuestas: {}, propuestas: {}, brief: {} },
    cierre: null,
    preguntasFinales: [],
    entregables: null,
    avisos: [],
  }
}

function seccionesConPreguntas(estado: EstadoCuestionario): Seccion[] {
  return (estado.examen?.secciones ?? []).filter((s) => s.preguntas.length > 0)
}

function seccionEnCurso(estado: EstadoCuestionario): Seccion {
  const seccion = seccionesConPreguntas(estado).find((s) => s.numero === estado.entrevista.seccion)
  if (!seccion) throw new ErrorEntrada('El cuestionario no tiene la sección en curso. Recargá la página.')
  return seccion
}

function archivosPublicos(estado: EstadoCuestionario, etapa: ArchivoMaterial['etapa']): ArchivoPublico[] {
  return estado.material.archivos.filter((a) => a.etapa === etapa).map((a) => ({ id: a.id, nombre: a.nombre, tipo: a.tipo }))
}

function extracto(texto: string, largo = 90): string {
  const plano = texto.replace(/\s+/g, ' ').trim()
  return plano.length > largo ? `${plano.slice(0, largo - 1)}…` : plano
}

export function pantallaActual(estado: EstadoCuestionario): Pantalla {
  switch (estado.etapa) {
    case 'triage': {
      const { indice, repregunta } = estado.triage
      return {
        tipo: 'pregunta',
        clave: `triage.${indice + 1}`,
        introduccion: indice === 0 && repregunta === null ? textos.INTRODUCCION_TRIAGE : null,
        texto: repregunta ?? preguntaTriage(indice).texto,
        esRepregunta: repregunta !== null,
      }
    }
    case 'pedido_chat':
      return { tipo: 'pedido_chat', texto: textos.PEDIDO_CHAT, sinChat: textos.SIN_CHAT, archivos: archivosPublicos(estado, 'pedido_chat') }
    case 'reconstruccion': {
      const indice = estado.reconstruccion.length
      return {
        tipo: 'pregunta',
        clave: `reconstruccion.${indice + 1}`,
        introduccion: null,
        texto: textos.PREGUNTAS_RECONSTRUCCION[indice],
        esRepregunta: false,
      }
    }
    case 'eleccion':
      return { tipo: 'eleccion', texto: textos.ELECCION_HIBRIDO, opciones: estado.clasificacion?.procesos ?? [] }
    case 'confirmacion':
      return { tipo: 'confirmacion', texto: estado.clasificacion?.mensaje ?? '' }
    case 'material':
      return {
        tipo: 'material',
        items: estado.examen?.material ?? [],
        archivos: archivosPublicos(estado, 'material'),
        textos: estado.material.textos.map((t) => ({ id: t.id, extracto: extracto(t.texto) })),
        aviso: estado.material.avisoFaltantes,
      }
    case 'entrevista': {
      const seccion = seccionEnCurso(estado)
      const pregunta = seccion.preguntas[estado.entrevista.indice]
      const repregunta = estado.entrevista.repregunta
      return {
        tipo: 'entrevista',
        seccion: { numero: seccion.numero, titulo: seccion.titulo },
        pregunta: { id: pregunta.id, texto: pregunta.texto },
        formato: SECCIONES_TEXTO_LITERAL.includes(seccion.numero) ? 'texto_literal' : 'dato',
        // Con una repregunta en curso ya contestó que cambió: la propuesta vieja no se vuelve a ofrecer.
        propuesta: repregunta ? null : (estado.entrevista.propuestas[pregunta.id] ?? null),
        repregunta,
      }
    }
    case 'preguntas_finales': {
      const pendiente = estado.preguntasFinales.findIndex((p) => p.respuesta === null)
      const indice = pendiente < 0 ? estado.preguntasFinales.length - 1 : pendiente
      return {
        tipo: 'pregunta_final',
        numero: indice + 1,
        total: estado.preguntasFinales.length,
        texto: estado.preguntasFinales[indice]?.texto ?? '',
      }
    }
    case 'terminado':
      return { tipo: 'gracias', texto: textos.GRACIAS }
  }
}

export function progreso(estado: EstadoCuestionario): { porcentaje: number; texto: string } {
  switch (estado.etapa) {
    case 'triage':
      return { porcentaje: Math.round((estado.triage.indice / textos.PREGUNTAS_TRIAGE.length) * 10), texto: 'Primeras preguntas' }
    case 'pedido_chat':
    case 'reconstruccion':
    case 'eleccion':
    case 'confirmacion':
      return { porcentaje: 12, texto: 'Primeras preguntas' }
    case 'material':
      return { porcentaje: 16, texto: 'Material para la entrevista' }
    case 'entrevista': {
      const secciones = seccionesConPreguntas(estado)
      const total = secciones.reduce((n, s) => n + s.preguntas.length, 0) || 1
      const hechas = Object.keys(estado.entrevista.respuestas).length
      const seccion = secciones.find((s) => s.numero === estado.entrevista.seccion)
      return {
        porcentaje: Math.min(90, 18 + Math.round((72 * hechas) / total)),
        texto: seccion ? `Sección ${seccion.numero} de 9 · ${seccion.titulo}` : 'Entrevista',
      }
    }
    case 'preguntas_finales': {
      const total = estado.preguntasFinales.length || 1
      const hechas = estado.preguntasFinales.filter((p) => p.respuesta !== null).length
      return { porcentaje: 92 + Math.round((6 * hechas) / total), texto: 'Últimas preguntas' }
    }
    case 'terminado':
      return { porcentaje: 100, texto: 'Terminado' }
  }
}

/** Qué decirle mientras se procesa lo que mandó. Los pasos largos avisan que tardan. */
export function mensajeEspera(estado: EstadoCuestionario, entrada: Entrada): string {
  switch (estado.etapa) {
    case 'triage':
      return estado.triage.indice >= textos.PREGUNTAS_TRIAGE.length - 1 ? 'Leyendo tus respuestas.' : 'Un momento.'
    case 'pedido_chat':
      return 'Leyendo la conversación.'
    case 'confirmacion':
      return entrada.tipo === 'confirmar'
        ? 'Estamos armando tu cuestionario a medida. Tarda un par de minutos.'
        : 'Leyendo tu corrección.'
    case 'material':
      return entrada.tipo === 'terminar_material'
        ? 'Leyendo lo que subiste. Si son muchas capturas, puede tardar unos minutos.'
        : 'Guardando.'
    case 'entrevista': {
      const secciones = seccionesConPreguntas(estado)
      const seccion = secciones.find((s) => s.numero === estado.entrevista.seccion)
      if (!seccion || estado.entrevista.indice < seccion.preguntas.length - 1) return 'Un momento.'
      return seccion.numero === secciones.at(-1)?.numero
        ? 'Estamos repasando todo lo que contaste. Puede tardar unos minutos.'
        : 'Guardando esta sección y preparando la que sigue.'
    }
    case 'preguntas_finales':
      return estado.preguntasFinales.filter((p) => p.respuesta === null).length <= 1
        ? 'Estamos cerrando todo. Puede tardar unos minutos.'
        : 'Un momento.'
    default:
      return 'Un momento.'
  }
}

function vacia(texto: string): boolean {
  return !texto.trim()
}

/**
 * Controla que la entrada corresponda a la pantalla, sin tocar nada ni llamar a la IA. La API
 * la usa antes de poner el cuestionario a procesar, para devolver el error en el momento.
 */
export function validarEntrada(estado: EstadoCuestionario, entrada: Entrada): void {
  switch (estado.etapa) {
    case 'triage':
    case 'reconstruccion':
      if (entrada.tipo !== 'respuesta') throw new ErrorEntrada('En este paso se espera una respuesta escrita.')
      if (vacia(entrada.texto)) throw new ErrorEntrada('La respuesta está vacía: escribí algo antes de seguir.')
      return
    case 'pedido_chat':
      if (entrada.tipo === 'sin_chat') return
      if (entrada.tipo !== 'respuesta') throw new ErrorEntrada('En este paso se pega la conversación o se sube la captura.')
      if (vacia(entrada.texto) && !estado.material.archivos.some((a) => a.etapa === 'pedido_chat')) {
        throw new ErrorEntrada('Pegá la conversación o subí las capturas antes de seguir.')
      }
      return
    case 'eleccion':
      if (entrada.tipo !== 'eleccion') throw new ErrorEntrada('En este paso hay que elegir uno de los dos procesos.')
      if (!(estado.clasificacion?.procesos ?? []).includes(entrada.opcion)) {
        throw new ErrorEntrada('La opción elegida no está entre las que se ofrecieron.')
      }
      return
    case 'confirmacion':
      if (entrada.tipo === 'confirmar') return
      if (entrada.tipo !== 'corregir') throw new ErrorEntrada('En este paso hay que confirmar o corregir lo que se entendió del negocio.')
      if (vacia(entrada.texto)) throw new ErrorEntrada('La corrección está vacía: escribí qué no es así.')
      return
    case 'material':
      if (entrada.tipo === 'terminar_material' || entrada.tipo === 'quitar_texto') return
      if (entrada.tipo !== 'texto_material') throw new ErrorEntrada('En este paso se sube material o se sigue con la entrevista.')
      if (vacia(entrada.texto)) throw new ErrorEntrada('El texto está vacío: pegá algo antes de agregarlo.')
      return
    case 'entrevista': {
      if (entrada.tipo === 'no_se') return
      if (entrada.tipo === 'sigue_igual') {
        const pregunta = seccionEnCurso(estado).preguntas[estado.entrevista.indice]
        if (estado.entrevista.repregunta || !estado.entrevista.propuestas[pregunta.id]) {
          throw new ErrorEntrada('En esta pregunta no hay nada para confirmar: escribí la respuesta.')
        }
        return
      }
      if (entrada.tipo === 'no_aplica') {
        if (vacia(entrada.texto)) throw new ErrorEntrada('Contá por qué no aplica a tu negocio: sin el motivo no se puede anotar.')
        return
      }
      if (entrada.tipo !== 'respuesta') throw new ErrorEntrada('En este paso se contesta la pregunta.')
      if (vacia(entrada.texto)) throw new ErrorEntrada('La respuesta está vacía: escribí algo, o tocá "No lo sé".')
      return
    }
    case 'preguntas_finales':
      if (entrada.tipo === 'no_se') return
      if (entrada.tipo !== 'respuesta' || vacia(entrada.texto)) throw new ErrorEntrada('Escribí la respuesta, o tocá "No lo sé".')
      return
    case 'terminado':
      throw new ErrorEntrada('El cuestionario ya está terminado.')
  }
}

export async function avanzar(estadoGuardado: EstadoCuestionario, entrada: Entrada, dep: Dependencias): Promise<EstadoCuestionario> {
  validarEntrada(estadoGuardado, entrada)
  // Se trabaja sobre una copia: si una llamada a la IA falla a mitad de camino, lo guardado
  // queda intacto y el cliente puede reenviar la misma entrada.
  const estado = structuredClone(estadoGuardado)

  switch (estado.etapa) {
    case 'triage':
      return responderTriage(estado, textoDe(entrada), dep)

    case 'pedido_chat':
      if (entrada.tipo === 'sin_chat') {
        estado.etapa = 'reconstruccion'
        return estado
      }
      return recibirChat(estado, entrada.tipo === 'respuesta' ? entrada.texto.trim() : '', dep)

    case 'reconstruccion': {
      const indice = estado.reconstruccion.length
      estado.reconstruccion.push({ pregunta: textos.PREGUNTAS_RECONSTRUCCION[indice], respuesta: textoDe(entrada) })
      // La skill no escala más allá de estas tres preguntas: con lo que haya, se clasifica.
      if (estado.reconstruccion.length < textos.PREGUNTAS_RECONSTRUCCION.length) return estado
      return clasificar(estado, dep)
    }

    case 'eleccion':
      if (entrada.tipo === 'eleccion') estado.procesoElegido = entrada.opcion
      return clasificar(estado, dep)

    case 'confirmacion':
      if (entrada.tipo === 'corregir') {
        estado.correcciones.push(entrada.texto.trim())
        return clasificar(estado, dep)
      }
      return generarExamen(estado, dep)

    case 'material':
      if (entrada.tipo === 'texto_material') {
        estado.material.textos.push({ id: randomUUID(), texto: entrada.texto.trim() })
        return estado
      }
      if (entrada.tipo === 'quitar_texto') {
        estado.material.textos = estado.material.textos.filter((t) => t.id !== entrada.id)
        return estado
      }
      return terminarMaterial(estado, dep)

    case 'entrevista':
      return responderEntrevista(estado, entrada, dep)

    case 'preguntas_finales': {
      const pendiente = estado.preguntasFinales.find((p) => p.respuesta === null)
      if (!pendiente) return terminar(estado, dep)
      pendiente.respuesta = entrada.tipo === 'respuesta' ? entrada.texto.trim() : '[PENDIENTE: no lo sabe]'
      if (estado.preguntasFinales.some((p) => p.respuesta === null)) return estado
      return terminar(estado, dep)
    }

    case 'terminado':
      throw new ErrorEntrada('El cuestionario ya está terminado.')
  }
}

function textoDe(entrada: Entrada): string {
  if (entrada.tipo !== 'respuesta') throw new ErrorEntrada('En este paso se espera una respuesta escrita.')
  return entrada.texto.trim()
}

async function pedir<T>(dep: Dependencias, paso: instrucciones.Paso): Promise<T> {
  const skill = await dep.skill(paso.skill)
  return dep.ia.pedirJson<T>({
    paso: paso.paso,
    sistema: [skill, instrucciones.CAPA_WEB],
    mensaje: paso.mensaje,
    esquema: paso.esquema,
    cache: paso.cache,
    esfuerzo: paso.esfuerzo,
    maxTokens: paso.maxTokens,
  })
}

// ---------------------------------------------------------------- mi-negocio

/**
 * La pregunta del triage que toca. Acotada: si el formulario pierde una pregunta con un
 * cuestionario a mitad del triage, el índice guardado puede pasarse de la última.
 */
function preguntaTriage(indice: number): textos.PreguntaTriage {
  return textos.PREGUNTAS_TRIAGE[Math.min(indice, textos.PREGUNTAS_TRIAGE.length - 1)]
}

async function responderTriage(estado: EstadoCuestionario, respuesta: string, dep: Dependencias): Promise<EstadoCuestionario> {
  const { indice, repregunta } = estado.triage
  const pregunta = preguntaTriage(indice)
  estado.triage.intercambios.push({ pregunta: repregunta ?? pregunta.texto, respuesta })

  // Una repregunta ya hecha no se evalúa: la skill permite una sola, y después se sigue con lo que haya.
  if (repregunta === null) {
    const evaluacion = await pedir<instrucciones.SalidaEvaluacion>(dep, instrucciones.evaluarTriage(estado, indice))
    if (evaluacion.decision === 'repreguntar') {
      // En la de la acción terminal la skill dicta el texto exacto de la repregunta.
      const texto = pregunta.enLaSkill === 1 ? textos.REPREGUNTA_ACCION_TERMINAL : evaluacion.repregunta.trim()
      if (texto) {
        estado.triage.repregunta = texto
        return estado
      }
    }
  }

  estado.triage.repregunta = null
  estado.triage.indice++
  if (estado.triage.indice < textos.PREGUNTAS_TRIAGE.length) return estado

  const alcance = await pedir<instrucciones.SalidaAlcance>(dep, instrucciones.evaluarAlcance(estado))
  if (!alcance.alcanza) {
    estado.etapa = 'pedido_chat'
    return estado
  }
  return clasificar(estado, dep)
}

async function recibirChat(estado: EstadoCuestionario, texto: string, dep: Dependencias): Promise<EstadoCuestionario> {
  const capturas = estado.material.archivos.filter((a) => a.etapa === 'pedido_chat')
  await transcribirPendientes(capturas, dep)
  estado.chat = [texto, ...capturas.map((a) => `### ${a.nombre}\n${a.texto ?? ''}`)].filter(Boolean).join('\n\n')
  return clasificar(estado, dep)
}

async function clasificar(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  const salida = await pedir<instrucciones.SalidaClasificacion>(dep, instrucciones.clasificar(estado))
  const hibrido = salida.hibrido && estado.procesoElegido === null && salida.procesos.length >= 2

  if (!hibrido && !salida.mensaje.trim()) {
    throw new ErrorIa('La clasificación volvió sin el mensaje para el dueño. Hay que reintentar el paso.', 'formato')
  }

  estado.clasificacion = {
    // La skill pide escribir la línea "Acción terminal del chat bueno: ..." y el modelo a veces
    // copia el rótulo adentro del valor: en el examen quedaba "Acción terminal: Acción terminal...".
    accionTerminal: salida.accion_terminal.replace(/^\s*acci[oó]n terminal(?: del chat bueno)?\s*:\s*/i, '').trim(),
    arquetipo: salida.arquetipo,
    hibrido,
    procesos: hibrido ? salida.procesos.map((p) => p.trim()) : [],
    mensaje: salida.mensaje.trim(),
  }
  estado.etapa = hibrido ? 'eleccion' : 'confirmacion'
  return estado
}

async function generarExamen(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  const clasificacion: Clasificacion | null = estado.clasificacion
  if (!clasificacion) throw new ErrorEntrada('No se puede armar el cuestionario sin haber confirmado cómo funciona el negocio.')

  let examen: Examen | null = null
  let errores: string[] = []
  for (let intento = 1; intento <= INTENTOS_EXAMEN; intento++) {
    const salida = await pedir<instrucciones.SalidaExamenModelo>(dep, instrucciones.generarExamen(estado, clasificacion, examen, errores))
    examen = armarExamen({
      ...salida,
      negocio: salida.negocio.trim() || estado.negocio,
      // Valen los que confirmó el dueño, no los que el modelo pueda reescribir.
      arquetipo: clasificacion.arquetipo,
      accion_terminal: clasificacion.accionTerminal,
    })
    // La skill dicta el texto exacto de la nota del cuestionario general.
    if (examen.nota) examen.nota = textos.NOTA_GENERICO
    errores = validarExamen(examen).errores
    if (errores.length === 0) break
    estado.avisos.push(`Intento ${intento} del cuestionario rechazado por: ${errores.join(' · ')}`)
  }

  // Todo es automático: si después de los reintentos quedan errores, se sigue igual y los
  // errores viajan en el reporte para que se vean.
  estado.examen = examen
  estado.pendientesExamen = errores
  estado.etapa = 'material'
  return estado
}

// ---------------------------------------------------------------- material

async function transcribirPendientes(archivos: ArchivoMaterial[], dep: Dependencias): Promise<void> {
  const pendientes = archivos.filter((a) => a.texto === null)
  let siguiente = 0
  // Varias a la vez: un cliente sube diez capturas de un chat y no tiene por qué esperar una por una.
  async function trabajar(): Promise<void> {
    while (siguiente < pendientes.length) {
      const archivo = pendientes[siguiente++]
      const datos = await dep.leerArchivo(archivo)
      const salida = await pedir<instrucciones.SalidaTranscripcion>(dep, instrucciones.transcribirArchivo(archivo, datos))
      archivo.texto = salida.texto.trim()
    }
  }
  await Promise.all(Array.from({ length: Math.min(TRANSCRIPCIONES_EN_PARALELO, pendientes.length) }, trabajar))
}

async function terminarMaterial(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  const subidos = estado.material.archivos.filter((a) => a.etapa === 'material')
  await transcribirPendientes(subidos, dep)
  const hayMaterial = subidos.length > 0 || estado.material.textos.length > 0

  // La skill avisa lo que falta una sola vez: la segunda vez que toca seguir, se sigue con lo que haya.
  if (estado.material.avisoFaltantes === null) {
    if (!hayMaterial) {
      estado.material.avisoFaltantes = textos.AVISO_SIN_MATERIAL
      return estado
    }
    const revision = await pedir<instrucciones.SalidaRevision>(dep, instrucciones.revisarMaterial(estado))
    const faltan = revision.faltan.map((f) => f.trim()).filter(Boolean)
    if (faltan.length) {
      estado.material.avisoFaltantes = textos.avisoFaltantes(faltan)
      return estado
    }
  }

  if (!hayMaterial) estado.avisos.push('La entrevista se hizo sin material: el recorrido no tiene chats reales de respaldo.')
  const primera = seccionesConPreguntas(estado)[0]
  if (!primera) throw new ErrorIa('El cuestionario no tiene preguntas para la entrevista.', 'formato')
  estado.etapa = 'entrevista'
  estado.entrevista.seccion = primera.numero
  estado.entrevista.indice = 0
  await proponer(estado, dep)
  return estado
}

// ---------------------------------------------------------------- entrevista

async function proponer(estado: EstadoCuestionario, dep: Dependencias): Promise<void> {
  if (!instrucciones.tieneMaterial(estado)) return
  const seccion = seccionEnCurso(estado)
  const salida = await pedir<instrucciones.SalidaPropuestas>(dep, instrucciones.proponerRespuestas(estado, seccion))
  const material = normalizarLiteral(instrucciones.textoDelMaterial(estado))
  for (const propuesta of salida.propuestas) {
    const fragmentos = fragmentosDePropuesta(propuesta.texto)
    const existe = seccion.preguntas.some((p) => p.id === propuesta.id)
    // Solo se propone lo que está escrito en el material: si el modelo parafraseó o pegó
    // pedazos en una oración, el dueño estaría confirmando algo que nunca escribió.
    if (!existe || !fragmentos.length || fragmentos.some((f) => !material.includes(normalizarLiteral(f)))) continue
    estado.entrevista.propuestas[propuesta.id] = {
      texto: fragmentos.join(`\n\n${SEPARADOR_FRAGMENTOS}\n\n`),
      fuente: propuesta.fuente.trim() || 'lo que subiste',
    }
  }
}

async function responderEntrevista(estado: EstadoCuestionario, entrada: Entrada, dep: Dependencias): Promise<EstadoCuestionario> {
  const seccion = seccionEnCurso(estado)
  const pregunta = seccion.preguntas[estado.entrevista.indice]
  const repregunta = estado.entrevista.repregunta
  const respuesta: RespuestaEntrevista = estado.entrevista.respuestas[pregunta.id] ?? {
    intercambios: [],
    estado: 'completa',
    propuesta: estado.entrevista.propuestas[pregunta.id] ?? null,
    sigueIgual: false,
    esPlan: false,
    nota: '',
  }
  const mostrada = repregunta ?? pregunta.texto

  switch (entrada.tipo) {
    case 'sigue_igual':
      respuesta.intercambios.push({ pregunta: pregunta.texto, respuesta: respuesta.propuesta!.texto })
      respuesta.sigueIgual = true
      respuesta.estado = 'completa'
      return cerrarPregunta(estado, seccion, pregunta.id, respuesta, dep)

    case 'no_se':
      respuesta.intercambios.push({ pregunta: mostrada, respuesta: '[No lo sabe]' })
      respuesta.estado = 'pendiente'
      respuesta.nota ||= pregunta.texto
      return cerrarPregunta(estado, seccion, pregunta.id, respuesta, dep)

    case 'no_aplica':
      respuesta.intercambios.push({ pregunta: mostrada, respuesta: `NO APLICA: ${entrada.texto.trim()}` })
      respuesta.estado = 'no_aplica'
      respuesta.nota = entrada.texto.trim()
      return cerrarPregunta(estado, seccion, pregunta.id, respuesta, dep)

    case 'respuesta': {
      respuesta.intercambios.push({ pregunta: mostrada, respuesta: entrada.texto.trim() })
      const yaRepreguntada = repregunta !== null
      const evaluacion = await pedir<instrucciones.SalidaEvaluacionEntrevista>(
        dep,
        instrucciones.evaluarRespuesta(estado, seccion, pregunta, respuesta, yaRepreguntada),
      )
      respuesta.esPlan ||= evaluacion.es_plan

      if (!yaRepreguntada && (evaluacion.responde_como_agente || evaluacion.decision === 'repreguntar')) {
        // La regla dura 4 de la skill dicta la frase exacta.
        const texto = evaluacion.responde_como_agente ? textos.FRASE_RESPONDE_COMO_AGENTE : evaluacion.repregunta.trim()
        if (texto) {
          estado.entrevista.respuestas[pregunta.id] = respuesta
          estado.entrevista.repregunta = texto
          return estado
        }
      }

      if (evaluacion.decision === 'no_aplica') {
        respuesta.estado = 'no_aplica'
        respuesta.nota = evaluacion.nota.trim()
      } else if (evaluacion.decision === 'aceptar' && !evaluacion.responde_como_agente) {
        respuesta.estado = 'completa'
        respuesta.nota = evaluacion.nota.trim()
      } else {
        // Pendiente, o vaga después de repreguntar: la skill no repregunta tres veces.
        respuesta.estado = 'pendiente'
        respuesta.nota = evaluacion.nota.trim() || pregunta.texto
      }
      return cerrarPregunta(estado, seccion, pregunta.id, respuesta, dep)
    }

    default:
      throw new ErrorEntrada('En este paso se contesta la pregunta.')
  }
}

async function cerrarPregunta(
  estado: EstadoCuestionario,
  seccion: Seccion,
  id: string,
  respuesta: RespuestaEntrevista,
  dep: Dependencias,
): Promise<EstadoCuestionario> {
  estado.entrevista.respuestas[id] = respuesta
  estado.entrevista.repregunta = null

  if (estado.entrevista.indice + 1 < seccion.preguntas.length) {
    estado.entrevista.indice++
    return estado
  }

  await escribirSeccion(estado, seccion, dep)
  const siguiente = seccionesConPreguntas(estado).find((s) => s.numero > seccion.numero)
  if (siguiente) {
    estado.entrevista.seccion = siguiente.numero
    estado.entrevista.indice = 0
    await proponer(estado, dep)
    return estado
  }
  return cerrarEntrevista(estado, dep)
}

/** Todo lo que el dueño dijo o subió para esa sección: contra esto se controlan las citas. */
function fuenteLiteral(estado: EstadoCuestionario, seccion: Seccion): string {
  const deLaSeccion = seccion.preguntas.flatMap((p) => [
    p.texto,
    ...(estado.entrevista.respuestas[p.id]?.intercambios ?? []).flatMap((i) => [i.pregunta, i.respuesta]),
  ])
  return [...deLaSeccion, instrucciones.textoDelMaterial(estado)].join('\n')
}

async function escribirSeccion(estado: EstadoCuestionario, seccion: Seccion, dep: Dependencias): Promise<void> {
  const literal = SECCIONES_TEXTO_LITERAL.includes(seccion.numero)
  let problemas: string[] = []
  let markdown = ''
  // Un reintento: si la segunda versión todavía cita algo que el dueño no dijo, se guarda y se avisa.
  for (let intento = 1; intento <= 2; intento++) {
    const salida = await pedir<instrucciones.SalidaSeccionBrief>(dep, instrucciones.escribirSeccionBrief(estado, seccion, problemas))
    markdown = salida.markdown.trim()
    problemas = literal ? citasQueNoAparecen(markdown, fuenteLiteral(estado, seccion)) : []
    if (!problemas.length) break
  }
  estado.entrevista.brief[String(seccion.numero)] = markdown
  if (problemas.length) {
    estado.avisos.push(
      `Sección ${seccion.numero} del brief: estos textos no aparecen tal cual en lo que dijo el dueño ni en su material: ${problemas.map((p) => `"${p}"`).join('; ')}`,
    )
  }
}

async function cerrarEntrevista(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  const salida = await pedir<instrucciones.SalidaCierre>(dep, instrucciones.analizarCierre(estado))
  estado.cierre = {
    estilo: salida.estilo,
    contradicciones: salida.contradicciones,
    cobertura: salida.cobertura,
    simulaciones: salida.simulaciones,
    agujeros: salida.agujeros,
  }
  estado.preguntasFinales = salida.preguntas_finales
    .map((p) => ({ texto: p.texto.trim(), motivo: p.motivo.trim(), respuesta: null }))
    .filter((p) => p.texto)
    .slice(0, MAXIMO_PREGUNTAS_FINALES)

  if (estado.preguntasFinales.length) {
    estado.etapa = 'preguntas_finales'
    return estado
  }
  return terminar(estado, dep)
}

async function terminar(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  if (!estado.examen) throw new ErrorEntrada('No se puede cerrar un cuestionario sin examen.')
  const plantilla = await dep.plantillaClaude()
  const salida = await pedir<instrucciones.SalidaBriefFinal>(dep, instrucciones.cerrarBrief(estado, plantilla))
  estado.entregables = {
    examen: examenAMarkdown(estado.examen),
    brief: `${salida.brief.trim()}\n`,
    claude: `${salida.claude.trim()}\n`,
    cierre: armarReporteCierre(estado, salida.pendientes),
  }
  estado.etapa = 'terminado'
  return estado
}
