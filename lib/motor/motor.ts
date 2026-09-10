import { ErrorIa, type ClienteIa } from '../claude'
import { armarExamen, validarExamen, type Examen } from '../examen'
import type { NombreSkill } from '../skills'
import * as instrucciones from './instrucciones'
import * as textos from './textos'
import type { Clasificacion, Entrada, EstadoCuestionario, Pantalla } from './tipos'

/**
 * El recorrido del cuestionario: dado el estado guardado y lo que mandó la pantalla, calcula
 * el estado siguiente. No toca la base ni la red salvo a través de `Dependencias`, así se
 * puede probar entero con una IA falsa.
 */

export interface Dependencias {
  ia: ClienteIa
  /** El texto de una skill. En producción sale de skills/; en las pruebas se inyecta. */
  skill: (nombre: NombreSkill) => Promise<string>
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
  }
}

export function pantallaActual(estado: EstadoCuestionario): Pantalla {
  switch (estado.etapa) {
    case 'triage': {
      const { indice, repregunta } = estado.triage
      return {
        tipo: 'pregunta',
        clave: `triage.${indice + 1}`,
        introduccion: indice === 0 && repregunta === null ? textos.INTRODUCCION_TRIAGE : null,
        texto: repregunta ?? textos.PREGUNTAS_TRIAGE[indice],
        esRepregunta: repregunta !== null,
      }
    }
    case 'pedido_chat':
      return { tipo: 'pedido_chat', texto: textos.PEDIDO_CHAT, sinChat: textos.SIN_CHAT }
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
      return { tipo: 'material', items: estado.examen?.material ?? [] }
  }
}

export async function avanzar(estadoGuardado: EstadoCuestionario, entrada: Entrada, dep: Dependencias): Promise<EstadoCuestionario> {
  // Se trabaja sobre una copia: si una llamada a la IA falla a mitad de camino, lo guardado
  // queda intacto y el cliente puede reenviar la misma respuesta.
  const estado = structuredClone(estadoGuardado)

  switch (estado.etapa) {
    case 'triage':
      return responderTriage(estado, textoDe(entrada), dep)

    case 'pedido_chat':
      if (entrada.tipo === 'sin_chat') {
        estado.etapa = 'reconstruccion'
        return estado
      }
      estado.chat = textoDe(entrada)
      return clasificar(estado, dep)

    case 'reconstruccion': {
      const indice = estado.reconstruccion.length
      estado.reconstruccion.push({ pregunta: textos.PREGUNTAS_RECONSTRUCCION[indice], respuesta: textoDe(entrada) })
      // La skill no escala más allá de estas tres preguntas: con lo que haya, se clasifica.
      if (estado.reconstruccion.length < textos.PREGUNTAS_RECONSTRUCCION.length) return estado
      return clasificar(estado, dep)
    }

    case 'eleccion': {
      if (entrada.tipo !== 'eleccion') throw new ErrorEntrada('En este paso hay que elegir uno de los dos procesos.')
      const opciones = estado.clasificacion?.procesos ?? []
      if (!opciones.includes(entrada.opcion)) throw new ErrorEntrada('La opción elegida no está entre las que se ofrecieron.')
      estado.procesoElegido = entrada.opcion
      return clasificar(estado, dep)
    }

    case 'confirmacion':
      if (entrada.tipo === 'corregir') {
        const correccion = entrada.texto.trim()
        if (!correccion) throw new ErrorEntrada('La corrección está vacía: escribí qué no es así.')
        estado.correcciones.push(correccion)
        return clasificar(estado, dep)
      }
      if (entrada.tipo !== 'confirmar') throw new ErrorEntrada('En este paso hay que confirmar o corregir lo que se entendió del negocio.')
      return generarExamen(estado, dep)

    case 'material':
      throw new ErrorEntrada('El material y la entrevista todavía no están disponibles.')
  }
}

function textoDe(entrada: Entrada): string {
  if (entrada.tipo !== 'respuesta') throw new ErrorEntrada('En este paso se espera una respuesta escrita.')
  const texto = entrada.texto.trim()
  if (!texto) throw new ErrorEntrada('La respuesta está vacía: escribí algo antes de seguir.')
  return texto
}

async function pedir<T>(dep: Dependencias, paso: instrucciones.Paso): Promise<T> {
  const skill = await dep.skill('mi-negocio')
  return dep.ia.pedirJson<T>({ ...paso, sistema: [skill, instrucciones.CAPA_WEB] })
}

async function responderTriage(estado: EstadoCuestionario, respuesta: string, dep: Dependencias): Promise<EstadoCuestionario> {
  const { indice, repregunta } = estado.triage
  const numero = indice + 1
  estado.triage.intercambios.push({ pregunta: repregunta ?? textos.PREGUNTAS_TRIAGE[indice], respuesta })

  // Una repregunta ya hecha no se evalúa: la skill permite una sola, y después se sigue con lo que haya.
  if (repregunta === null) {
    const evaluacion = await pedir<instrucciones.SalidaEvaluacion>(dep, instrucciones.evaluarTriage(estado, numero))
    if (evaluacion.decision === 'repreguntar') {
      // En la pregunta 1 la skill dicta el texto exacto de la repregunta.
      const texto = numero === 1 ? textos.REPREGUNTA_ACCION_TERMINAL : evaluacion.repregunta.trim()
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

async function clasificar(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  const salida = await pedir<instrucciones.SalidaClasificacion>(dep, instrucciones.clasificar(estado))
  const hibrido = salida.hibrido && estado.procesoElegido === null && salida.procesos.length >= 2

  if (!hibrido && !salida.mensaje.trim()) {
    throw new ErrorIa('La clasificación volvió sin el mensaje para el dueño. Hay que reintentar el paso.', 'formato')
  }

  estado.clasificacion = {
    accionTerminal: salida.accion_terminal.trim(),
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
    const salida = await pedir<instrucciones.SalidaExamenModelo>(
      dep,
      instrucciones.generarExamen(estado, clasificacion, examen, errores),
    )
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
  }

  // Todo es automático: si después de los reintentos quedan errores, se sigue igual y los
  // errores viajan en el reporte para que se vean.
  estado.examen = examen
  estado.pendientesExamen = errores
  estado.etapa = 'material'
  return estado
}
