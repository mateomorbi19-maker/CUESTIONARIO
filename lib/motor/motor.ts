import { randomUUID } from 'node:crypto'
import { ErrorIa, type ClienteIa } from '../claude'
import { armarExamen, examenAMarkdown, SECCIONES_TEXTO_LITERAL, validarExamen, type Examen, type Seccion } from '../examen'
import type { NombreSkill } from '../skills'
import * as instrucciones from './instrucciones'
import { citasQueNoAparecen, fragmentosDePropuesta, normalizarLiteral, SEPARADOR_FRAGMENTOS } from './literal'
import { esChat, grupoEfectivo, indiceDeMaterial, recorteDelMaterial, textoDeArchivos, tieneMarcadorDeLaApp } from './material'
import { armarReporteCierre } from './reporte'
import * as textos from './textos'
import type {
  ArchivoMaterial,
  ArchivoPublico,
  Clasificacion,
  Entrada,
  EstadoCuestionario,
  Fotogramas,
  ImagenParaClaude,
  Pantalla,
  RespuestaEntrevista,
  Transcripcion,
} from './tipos'

/**
 * El recorrido del cuestionario: dado el estado guardado y lo que mandó la pantalla, calcula
 * el estado siguiente. No toca la base ni la red salvo a través de `Dependencias`, así se
 * puede probar entero con una IA falsa.
 */

/**
 * Falla de ffmpeg o del transcriptor con un archivo. Nunca es pasajera para el motor: el archivo
 * queda con su nota y se sigue. Si frenara, un audio que falla siempre dejaría el material
 * trabado en cada «Reintentar».
 */
export class ErrorMultimedia extends Error {
  constructor(
    message: string,
    /**
     * 'sin_herramienta': falta ffmpeg o el transcriptor, o se cayó (no es culpa del archivo).
     * 'ilegible': el archivo no se pudo decodificar. 'tiempo': se pasó del tope.
     */
    readonly causa: 'sin_herramienta' | 'ilegible' | 'tiempo',
  ) {
    super(message)
    this.name = 'ErrorMultimedia'
  }
}

export interface Dependencias {
  ia: ClienteIa
  /** El texto de una skill. En producción sale de skills/; en las pruebas se inyecta. */
  skill: (nombre: NombreSkill) => Promise<string>
  /** La plantilla de CLAUDE.md del starter kit. */
  plantillaClaude: () => Promise<string>
  /** El contenido de un archivo subido, para transcribirlo. */
  leerArchivo: (archivo: ArchivoMaterial) => Promise<Buffer>
  /** La original si ya sirve. Si no (HEIC, BMP, TIFF, AVIF, más de ~7,5 MB o de 8000 px), JPEG de 1568 px. Tira ErrorMultimedia. */
  imagenParaClaude: (archivo: ArchivoMaterial) => Promise<ImagenParaClaude>
  /** Whisper local del audio de un audio o video. Sin pista de audio: sinVoz true. Tira ErrorMultimedia. */
  transcribirAudio: (archivo: ArchivoMaterial) => Promise<Transcripcion>
  /** Fotogramas parejos en JPEG de hasta 1024 px. Sin pista de video: cuadros [] y tieneVideo false. Tira ErrorMultimedia. */
  fotogramasDeVideo: (archivo: ArchivoMaterial) => Promise<Fotogramas>
  /**
   * Cuánto se espera, en total, a todo lo que se lee al seguir (Claude y Whisper) antes de volver
   * a la lista. Por defecto PLAZO_LECTURA_MS. Las pruebas lo achican.
   */
  plazoMultimediaMs?: number
  /**
   * Dónde guardar la descripción de un video, por hash: si el audio no llega a tiempo, la próxima
   * vez no se le vuelve a pagar a Claude por mirar los mismos cuadros. Opcional: sin esto se
   * describe de nuevo.
   */
  descripcionGuardada?: (archivo: ArchivoMaterial) => Promise<string | null>
  guardarDescripcion?: (archivo: ArchivoMaterial, descripcion: string) => Promise<void>
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
const LECTURAS_CON_CLAUDE_EN_PARALELO = 4
// El transcriptor escucha de a uno en todo el servidor; con dos pedidos a la vez, el segundo ya
// tiene su audio decodificado cuando termina el primero.
const ESCUCHAS_EN_PARALELO = 2
/**
 * Cuánto se espera a todo lo que se lee al seguir, si `Dependencias` no dice otra cosa. El mismo
 * valor que MINUTOS_PLAZO_LECTURA de lib/cuestionarios.ts, que es el que usa la app.
 */
export const PLAZO_LECTURA_MS = 7 * 60_000

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
    material: { archivos: [], textos: [], avisoFaltantes: null, avisoLectura: null },
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

function estadoDeArchivo(archivo: ArchivoMaterial): ArchivoPublico['estado'] {
  if (archivo.texto === null) return archivo.problema === textos.PROBLEMA_EN_PROCESO ? 'en_proceso' : 'sin_leer'
  return archivo.problema ? 'con_problema' : 'listo'
}

function archivosPublicos(estado: EstadoCuestionario, etapa: ArchivoMaterial['etapa']): ArchivoPublico[] {
  const deLaEtapa = estado.material.archivos.filter((a) => a.etapa === etapa)
  // La conversación que ve el dueño es la misma con la que se arma el material para Claude.
  const grupos = grupoEfectivo(deLaEtapa)
  return deLaEtapa.map((a) => {
    const estadoArchivo = estadoDeArchivo(a)
    return {
      id: a.id,
      nombre: a.nombre,
      tipo: a.tipo,
      estado: estadoArchivo,
      // «Todavía lo estamos escuchando» no es un problema: la pantalla lo cuenta aparte.
      problema: estadoArchivo === 'con_problema' ? (a.problema ?? null) : null,
      grupo: grupos.get(a.id) ?? null,
      esChat: esChat(a),
      duracion: a.duracion ?? null,
      bytes: a.bytes,
    }
  })
}

/**
 * Por qué volvió a la lista. Los cuestionarios que ya estaban en el material antes de este campo
 * no lo traen: ahí el aviso se deduce de los archivos con problema, como hacía la pantalla.
 */
function avisoDeLectura(estado: EstadoCuestionario): string | null {
  const aviso = estado.material.avisoLectura
  if (aviso !== undefined) return aviso
  return estado.material.archivos.some((a) => a.etapa === 'material' && a.problema) ? textos.AVISO_LECTURA : null
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
        avisoLectura: avisoDeLectura(estado),
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
      return hayMultimediaSinLeer(estado, 'pedido_chat') ? 'Leyendo la conversación y escuchando los audios.' : 'Leyendo la conversación.'
    case 'confirmacion':
      return entrada.tipo === 'confirmar'
        ? 'Estamos armando tu cuestionario a medida. Tarda un par de minutos.'
        : 'Leyendo tu corrección.'
    case 'material':
      if (entrada.tipo !== 'terminar_material') return 'Guardando.'
      return hayMultimediaSinLeer(estado, 'material')
        ? 'Escuchando los audios y mirando los videos. Puede tardar unos minutos.'
        : 'Leyendo lo que subiste. Si son muchas capturas, puede tardar unos minutos.'
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

function hayMultimediaSinLeer(estado: EstadoCuestionario, etapa: ArchivoMaterial['etapa']): boolean {
  return estado.material.archivos.some((a) => a.etapa === etapa && a.texto === null && (a.tipo === 'audio' || a.tipo === 'video'))
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
  const subidos = estado.material.archivos.filter((a) => a.etapa === 'pedido_chat')
  // Acá no se frena por un archivo que no se leyó: con el texto y los demás alcanza para clasificar.
  const lectura = await leerPendientes(subidos, estado.material.archivos, dep)
  anotarLectura(estado, lectura)
  for (const archivo of lectura.enCurso) {
    // En este paso nadie vuelve a tocar «Seguir» para retomarlo: se sigue sin él y queda dicho.
    archivo.texto = ''
    archivo.problema = problemaPorTipo(archivo)
    estado.avisos.push(`Archivo «${archivo.nombre}» del chat del principio: no se llegó a leer dentro del plazo y se siguió sin él.`)
  }
  // Lo pegado lo escribió una persona: no puede traer los corchetes que marcan lo automático. Lo
  // subido se arma igual que el material, cada conversación por separado y con sus adjuntos en su lugar.
  const pegado = texto.replace(/⟪/g, '«').replace(/⟫/g, '»')
  estado.chat = [pegado, textoDeArchivos(subidos)].filter(Boolean).join('\n\n')
  // Si no quedó nada legible es como no tener el chat: la skill lo reconstruye con tres preguntas.
  if (!estado.chat) {
    estado.chat = null
    estado.etapa = 'reconstruccion'
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

/** Un archivo que no se pudo leer entero, con el detalle para el reporte. */
interface ProblemaDeLectura {
  archivo: ArchivoMaterial
  detalle: string
}

interface Lectura {
  problemas: ProblemaDeLectura[]
  /** Los que no llegaron a leerse dentro del plazo. Quedan con `texto: null` y se retoman en el próximo «Seguir». */
  enCurso: ArchivoMaterial[]
  /** Lo que salió a medias sin dejar el archivo con problema: un video que se ve pero no se escucha. */
  notas: string[]
}

/** Cómo salió una de las dos mitades de un video, o la escucha de un audio. */
type Parte<T> = { estado: 'listo'; valor: T } | { estado: 'fallo'; detalle: string } | { estado: 'vencido' }

/** Lo que se ve en un video. `descripcion` null: no tiene pista de imagen, es un audio. */
interface Vista {
  descripcion: string | null
  segundos: number | null
}

const PLAZO_VENCIDO = Symbol('plazo vencido')

function esNoEncontrado(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT'
}

/**
 * Lo que tira ffmpeg o el transcriptor nunca es pasajero: no hay red de por medio y repetirlo da
 * lo mismo. Si un error de esos saliera sin clasificar, el motor lo tomaría por pasajero y el
 * material quedaría trabado en cada «Reintentar».
 */
async function conMultimedia<T>(tarea: Promise<T>): Promise<T> {
  try {
    return await tarea
  } catch (err) {
    if (err instanceof ErrorMultimedia || esNoEncontrado(err)) throw err
    throw new ErrorMultimedia(err instanceof Error ? err.message : String(err), 'ilegible')
  }
}

/** Espera la tarea hasta `limite`. Si no llega, devuelve PLAZO_VENCIDO y la tarea sigue por su cuenta. */
async function hastaElPlazo<T>(tarea: Promise<T>, limite: number): Promise<T | typeof PLAZO_VENCIDO> {
  let reloj: ReturnType<typeof setTimeout> | undefined
  const vencimiento = new Promise<typeof PLAZO_VENCIDO>((resolver) => {
    reloj = setTimeout(() => resolver(PLAZO_VENCIDO), Math.max(0, limite - Date.now()))
  })
  try {
    return await Promise.race([tarea, vencimiento])
  } finally {
    clearTimeout(reloj)
    // Si ganó el reloj, la tarea sigue sola: que falle después no puede quedar como un rechazo sin atender.
    tarea.catch(() => undefined)
  }
}

/** Por qué no se pudo leer, si la falla es del archivo y repetirla da lo mismo. null: es pasajera y reintentar puede arreglarla. */
function fallaDelArchivo(err: unknown): string | null {
  if (esNoEncontrado(err)) return 'no estaba en el disco del servidor, se perdió después de subirlo'
  if (err instanceof ErrorMultimedia) {
    const detalles: Record<ErrorMultimedia['causa'], string> = {
      sin_herramienta: `falta o falló una herramienta del servidor (${err.message}). Revisá /api/salud`,
      ilegible: `no se pudo abrir (${err.message})`,
      tiempo: `tardó más del tiempo máximo (${err.message})`,
    }
    return detalles[err.causa]
  }
  if (!(err instanceof ErrorIa)) return null
  const detalles: Partial<Record<ErrorIa['causa'], string>> = {
    cortada: 'la transcripción llegó al techo de tokens sin terminar',
    invalido: `Claude no acepta el archivo (${err.message})`,
    rechazo: 'Claude no quiso transcribirlo',
    formato: err.message,
  }
  return detalles[err.causa] ?? null
}

function problemaPorTipo(archivo: ArchivoMaterial): string {
  if (archivo.tipo === 'audio') return textos.PROBLEMA_AUDIO
  if (archivo.tipo === 'video') return textos.PROBLEMA_VIDEO
  return textos.PROBLEMA_ILEGIBLE
}

/** Si la falla es del archivo y no pasajera, lo deja marcado y dice qué pasó. Si no, null. */
function marcarNoLeido(archivo: ArchivoMaterial, err: unknown): ProblemaDeLectura | null {
  if (err instanceof ErrorIa && err.causa === 'cortada' && archivo.tipo === 'pdf') {
    // Un documento largo de verdad: lo leído hasta el techo sirve. En una imagen no pasa nunca
    // salvo que Claude se quede repitiendo, y eso no se guarda.
    // La última línea quedó a medias («Modelo B: $2» de un precio más largo): propuesta como texto
    // literal, el dueño confirmaría un dato que no es. Se descarta.
    const cortado = textoDeJsonCortado(err.parcial ?? '')
    const leido = (cortado.includes('\n') ? cortado.slice(0, cortado.lastIndexOf('\n')) : cortado).trim()
    if (leido) {
      archivo.texto = `${leido}\n\n${textos.MARCA_TRANSCRIPCION_CORTADA}`
      archivo.problema = textos.PROBLEMA_LARGO
      return { archivo, detalle: `es tan largo que la transcripción llegó al techo de tokens: quedaron los primeros ${leido.length} caracteres y el resto no se leyó` }
    }
  }
  const detalle = fallaDelArchivo(err)
  if (detalle === null) return null
  archivo.texto = ''
  archivo.problema = esNoEncontrado(err) ? textos.PROBLEMA_PERDIDO : problemaPorTipo(archivo)
  return { archivo, detalle }
}

function aplicarEscucha(archivo: ArchivoMaterial, transcripcion: Transcripcion): void {
  archivo.texto = textoEscuchado(transcripcion)
  archivo.duracion = transcripcion.segundos
  if (transcripcion.dudosa) archivo.dudosa = true
  else delete archivo.dudosa
  delete archivo.problema
  delete archivo.descripcion
}

function textoEscuchado(transcripcion: Transcripcion): string {
  const texto = transcripcion.texto.trim()
  // Con silencio Whisper inventa palabras sueltas: mejor decir que no habla nadie.
  if (transcripcion.sinVoz || !texto) return textos.TEXTO_SIN_VOZ
  return transcripcion.recortada ? `${texto} (se escucharon los primeros 15 minutos)` : texto
}

/** Dos archivos con los mismos bytes dan lo mismo: el segundo copia lo que salió del primero. */
function copiarLectura(origen: ArchivoMaterial, destino: ArchivoMaterial): void {
  destino.texto = origen.texto
  destino.tipo = origen.tipo
  for (const campo of ['problema', 'duracion', 'dudosa', 'descripcion'] as const) {
    if (origen[campo] === undefined) delete destino[campo]
    else Object.assign(destino, { [campo]: origen[campo] })
  }
}

/**
 * Lee lo que falta de `archivos` y dice qué no se pudo leer y qué no llegó a tiempo. `todos` es
 * el material entero: de ahí sale en qué conversación está cada archivo.
 *
 * - Fotos y PDF los lee Claude; de los videos mira unos cuadros. Audios y videos se escuchan con
 *   el transcriptor del servidor. Las dos cosas corren a la vez.
 * - Un archivo que falla siempre (una imagen que la API rechaza, un audio que ffmpeg no abre, uno
 *   que se perdió del disco) no puede frenar a todos: quedaría trabado en cada «Reintentar». Se
 *   anota y se sigue. Una falla pasajera de Claude sí frena, porque reintentar la arregla.
 * - Hay un solo plazo para todo. Al vencer no se toma trabajo nuevo: lo que falta queda sin leer
 *   y se retoma después. Sin plazo, cuatrocientas fotos o una hora de audio pasarían el tiempo
 *   del candado y la pantalla ofrecería reintentar lo que todavía está corriendo.
 */
async function leerPendientes(archivos: ArchivoMaterial[], todos: ArchivoMaterial[], dep: Dependencias): Promise<Lectura> {
  const limite = Date.now() + (dep.plazoMultimediaMs ?? PLAZO_LECTURA_MS)
  const lectura: Lectura = { problemas: [], enCurso: [], notas: [] }
  const pasajeras: unknown[] = []
  const indice = indiceDeMaterial(todos)

  // El mismo video mandado en dos chats se mira y se escucha una sola vez.
  const yaLeidos = new Map<string, ArchivoMaterial>()
  for (const archivo of todos) if (archivo.hash && archivo.texto !== null && !yaLeidos.has(archivo.hash)) yaLeidos.set(archivo.hash, archivo)
  const primeros = new Map<string, ArchivoMaterial>()
  const copias = new Map<ArchivoMaterial, ArchivoMaterial[]>()
  const pendientes: ArchivoMaterial[] = []
  for (const archivo of archivos) {
    if (archivo.texto !== null) continue
    if (archivo.tipo === 'texto' || archivo.tipo === 'otro') {
      // No hay nada que leer después de subirlo: no puede quedar pendiente para siempre.
      archivo.texto = ''
      continue
    }
    const leido = archivo.hash ? yaLeidos.get(archivo.hash) : undefined
    if (leido) {
      copiarLectura(leido, archivo)
      if (archivo.problema) lectura.problemas.push({ archivo, detalle: `es el mismo archivo que «${leido.nombre}», que no se pudo leer entero` })
      continue
    }
    const primero = archivo.hash ? primeros.get(archivo.hash) : undefined
    if (primero) {
      copias.get(primero)!.push(archivo)
      continue
    }
    if (archivo.hash) primeros.set(archivo.hash, archivo)
    copias.set(archivo, [])
    pendientes.push(archivo)
  }

  const vistas = new Map<ArchivoMaterial, Parte<Vista>>()
  const escuchas = new Map<ArchivoMaterial, Parte<Transcripcion>>()

  async function leerConClaude(archivo: ArchivoMaterial): Promise<void> {
    const contexto = indice.contexto(archivo)
    let paso: instrucciones.Paso
    if (archivo.tipo === 'imagen') {
      const imagen = await conMultimedia(dep.imagenParaClaude(archivo))
      paso = instrucciones.transcribirArchivo(archivo, imagen.datos, imagen.mime, contexto)
    } else {
      paso = instrucciones.transcribirArchivo(archivo, await dep.leerArchivo(archivo), 'application/pdf', contexto)
    }
    const salida = await pedir<instrucciones.SalidaTranscripcion>(dep, paso)
    archivo.texto = (salida.texto ?? '').trim()
    const descripcion = (salida.descripcion ?? '').trim()
    if (descripcion) archivo.descripcion = descripcion
    else delete archivo.descripcion
    delete archivo.problema
  }

  async function mirar(archivo: ArchivoMaterial): Promise<Vista> {
    // Ya se describió en un intento anterior que no llegó a escuchar el audio: no se paga de nuevo.
    if (archivo.descripcion !== undefined) return { descripcion: archivo.descripcion, segundos: archivo.duracion ?? null }
    const guardada = dep.descripcionGuardada ? await dep.descripcionGuardada(archivo).catch(() => null) : null
    if (guardada !== null) return { descripcion: guardada, segundos: null }
    const fotogramas: Fotogramas = await conMultimedia(dep.fotogramasDeVideo(archivo))
    if (!fotogramas.tieneVideo || !fotogramas.cuadros.length) return { descripcion: null, segundos: fotogramas.segundos }
    const salida = await pedir<instrucciones.SalidaVideo>(
      dep,
      instrucciones.describirVideo(archivo, fotogramas.cuadros, fotogramas.segundos, indice.contexto(archivo)),
    )
    const descripcion = (salida.descripcion ?? '').trim()
    if (dep.guardarDescripcion) await dep.guardarDescripcion(archivo, descripcion).catch(() => undefined)
    return { descripcion, segundos: fotogramas.segundos }
  }

  // Carril de Claude: fotos, PDF y los cuadros de los videos.
  const paraClaude = pendientes.filter((a) => a.tipo === 'imagen' || a.tipo === 'pdf' || a.tipo === 'video')
  let siguienteDeClaude = 0
  async function trabajarConClaude(): Promise<void> {
    // Después de una falla pasajera no se arranca otra: se reintenta todo junto y no se gasta de más.
    while (!pasajeras.length && siguienteDeClaude < paraClaude.length && Date.now() < limite) {
      const archivo = paraClaude[siguienteDeClaude++]
      try {
        if (archivo.tipo === 'video') vistas.set(archivo, { estado: 'listo', valor: await mirar(archivo) })
        else await leerConClaude(archivo)
      } catch (err) {
        if (archivo.tipo === 'video') {
          const detalle = fallaDelArchivo(err)
          if (detalle === null) pasajeras.push(err)
          else vistas.set(archivo, { estado: 'fallo', detalle })
          continue
        }
        const problema = marcarNoLeido(archivo, err)
        if (problema) lectura.problemas.push(problema)
        else pasajeras.push(err)
      }
    }
  }

  // Carril local: el audio de los audios y de los videos.
  const paraEscuchar = pendientes.filter((a) => a.tipo === 'audio' || a.tipo === 'video')
  let siguienteParaEscuchar = 0
  async function escuchar(): Promise<void> {
    while (!pasajeras.length && siguienteParaEscuchar < paraEscuchar.length && Date.now() < limite) {
      const archivo = paraEscuchar[siguienteParaEscuchar++]
      try {
        const resultado = await hastaElPlazo(conMultimedia(dep.transcribirAudio(archivo)), limite)
        escuchas.set(archivo, resultado === PLAZO_VENCIDO ? { estado: 'vencido' } : { estado: 'listo', valor: resultado })
      } catch (err) {
        // conMultimedia ya clasificó todo: acá nunca llega una falla pasajera.
        escuchas.set(archivo, { estado: 'fallo', detalle: fallaDelArchivo(err) ?? String(err) })
      }
    }
  }

  await Promise.all([
    ...Array.from({ length: Math.min(LECTURAS_CON_CLAUDE_EN_PARALELO, paraClaude.length) }, trabajarConClaude),
    ...Array.from({ length: Math.min(ESCUCHAS_EN_PARALELO, paraEscuchar.length) }, escuchar),
  ])
  if (pasajeras.length) throw pasajeras[0]

  const fallo = (archivo: ArchivoMaterial, detalle: string) => {
    archivo.texto = ''
    archivo.problema = problemaPorTipo(archivo)
    lectura.problemas.push({ archivo, detalle })
  }
  const enEspera = (archivo: ArchivoMaterial) => {
    archivo.texto = null
    // Solo lo que se escucha lleva esta nota: de una foto sin leer no se puede decir «lo estamos escuchando».
    if (archivo.tipo === 'audio' || archivo.tipo === 'video') archivo.problema = textos.PROBLEMA_EN_PROCESO
    lectura.enCurso.push(archivo)
  }

  for (const archivo of pendientes) {
    if (archivo.tipo === 'imagen' || archivo.tipo === 'pdf') {
      if (archivo.texto === null) enEspera(archivo)
      continue
    }
    const escucha = escuchas.get(archivo)
    if (archivo.tipo === 'audio') {
      if (!escucha || escucha.estado === 'vencido') enEspera(archivo)
      else if (escucha.estado === 'fallo') fallo(archivo, escucha.detalle)
      else aplicarEscucha(archivo, escucha.valor)
      continue
    }

    const vista = vistas.get(archivo)
    if (vista?.estado === 'listo' && vista.valor.descripcion === null) {
      // No tiene imagen: es un audio guardado como video (pasa con las notas de voz en .mp4).
      archivo.tipo = 'audio'
      if (!escucha || escucha.estado === 'vencido') enEspera(archivo)
      else if (escucha.estado === 'fallo') fallo(archivo, escucha.detalle)
      else aplicarEscucha(archivo, escucha.valor)
      continue
    }
    if (!vista || !escucha || escucha.estado === 'vencido') {
      // Lo que ya se vio queda guardado en el archivo para no mirarlo de nuevo.
      if (vista?.estado === 'listo' && vista.valor.descripcion !== null) archivo.descripcion = vista.valor.descripcion
      enEspera(archivo)
      continue
    }
    if (vista.estado !== 'listo' && escucha.estado !== 'listo') {
      // Solo si fallan las dos mitades el video queda con problema.
      const deLaVista = vista.estado === 'fallo' ? vista.detalle : 'no se llegó a mirar'
      const deLaEscucha = escucha.estado === 'fallo' ? escucha.detalle : 'no se llegó a escuchar'
      fallo(archivo, `no se pudo ver (${deLaVista}) ni escuchar (${deLaEscucha})`)
      delete archivo.descripcion
      continue
    }
    const seVe = vista.estado === 'listo' ? vista.valor.descripcion || 'no se distingue nada' : 'no se pudo ver'
    const seEscucha = escucha.estado === 'listo' ? textoEscuchado(escucha.valor) : 'no se pudo escuchar'
    archivo.texto = `Se ve: ${seVe}\nSe escucha: ${seEscucha}`
    const segundos = escucha.estado === 'listo' ? escucha.valor.segundos : vista.estado === 'listo' ? vista.valor.segundos : null
    if (segundos !== null) archivo.duracion = segundos
    if (escucha.estado === 'listo' && escucha.valor.dudosa) archivo.dudosa = true
    else delete archivo.dudosa
    delete archivo.problema
    delete archivo.descripcion
    if (vista.estado === 'fallo') lectura.notas.push(`Archivo «${archivo.nombre}»: el video se escuchó pero no se pudo ver: ${vista.detalle}.`)
    if (escucha.estado === 'fallo') lectura.notas.push(`Archivo «${archivo.nombre}»: el video se vio pero no se pudo escuchar: ${escucha.detalle}.`)
  }

  for (const [original, iguales] of copias) {
    for (const copia of iguales) {
      copiarLectura(original, copia)
      if (lectura.enCurso.includes(original)) lectura.enCurso.push(copia)
      else if (original.problema) lectura.problemas.push({ archivo: copia, detalle: `es el mismo archivo que «${original.nombre}», que no se pudo leer` })
    }
  }
  return lectura
}

/**
 * El valor de "texto" de un JSON que se cortó a mitad de camino: `{"texto": "lo que alcanzó`.
 * Un escape cortado al final no se puede leer y se descarta.
 */
export function textoDeJsonCortado(crudo: string): string {
  const inicio = /^\s*\{\s*"texto"\s*:\s*"/.exec(crudo)
  if (!inicio) return ''
  const resto = crudo.slice(inicio[0].length)
  let fin = resto.length
  for (let i = 0; i < resto.length; i++) {
    if (resto[i] === '"') {
      fin = i
      break
    }
    if (resto[i] !== '\\') continue
    const largo = resto[i + 1] === 'u' ? 6 : 2
    if (i + largo > resto.length) {
      fin = i
      break
    }
    i += largo - 1
  }
  try {
    // Un emoji partido en el corte deja media pareja: Postgres no la acepta dentro de un JSON.
    return (JSON.parse(`"${resto.slice(0, fin)}"`) as string).replace(/[\ud800-\udbff]$/, '')
  } catch {
    return ''
  }
}

function anotarLectura(estado: EstadoCuestionario, lectura: Lectura): void {
  for (const { archivo, detalle } of lectura.problemas) estado.avisos.push(`Archivo «${archivo.nombre}»: ${detalle}.`)
  estado.avisos.push(...lectura.notas)
}

const AVISO_DE_RECORTE = 'El material no entró entero en lo que lee Claude y se recortó: '

async function terminarMaterial(estado: EstadoCuestionario, dep: Dependencias): Promise<EstadoCuestionario> {
  estado.material.avisoLectura = null
  const subidos = estado.material.archivos.filter((a) => a.etapa === 'material')
  const lectura = await leerPendientes(subidos, estado.material.archivos, dep)
  anotarLectura(estado, lectura)

  // Se vuelve a la lista si algo todavía se está escuchando, o si no se pudo leer un archivo
  // suelto o el chat mismo: eso el dueño lo puede cambiar. El adjunto de una conversación no
  // frena: nadie puede volver a grabar el audio de un cliente, y queda anotado para el reporte.
  // Lo que sí se leyó queda guardado y al tocar «Seguir» no se vuelve a leer.
  const indice = indiceDeMaterial(subidos)
  const frenan = lectura.problemas.filter((problema) => !indice.esAdjunto(problema.archivo))
  if (lectura.enCurso.length || frenan.length) {
    estado.material.avisoLectura = lectura.enCurso.length ? textos.AVISO_EN_PROCESO : textos.AVISO_LECTURA
    return estado
  }

  const recorte = recorteDelMaterial(estado)
  if (recorte && !estado.avisos.some((aviso) => aviso.startsWith(AVISO_DE_RECORTE))) estado.avisos.push(`${AVISO_DE_RECORTE}${recorte}.`)

  // Un archivo que no se pudo leer cuenta como subido: decirle «todavía no subiste nada» al lado
  // de su archivo lo confunde. Lo que falta lo dice la revisión del material.
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
  // Contra la versión sin transcripciones ni descripciones automáticas: lo que dijo Whisper o
  // describió Claude no lo escribió el dueño y no se le puede proponer como suyo.
  const material = normalizarLiteral(instrucciones.textoLiteralDelMaterial(estado))
  // Sonnet a veces devuelve una misma pregunta en varias propuestas, un pedazo en cada una: se
  // juntan en orden. Quedarse con la última le mostraba al dueño uno solo de once colores.
  const juntas = new Map<string, { fragmentos: string[]; fuentes: string[] }>()
  for (const propuesta of salida.propuestas) {
    const fragmentos = fragmentosDePropuesta(propuesta.texto)
    const existe = seccion.preguntas.some((p) => p.id === propuesta.id)
    // Solo se propone lo que está escrito en el material: si el modelo parafraseó o pegó
    // pedazos en una oración, el dueño estaría confirmando algo que nunca escribió. Tampoco un
    // fragmento que arrastre un rótulo de la app («[Foto «0001.jpg»: …]»): vería nombres de archivo.
    const escritoPorElDueno = (f: string) => !tieneMarcadorDeLaApp(f) && material.includes(normalizarLiteral(f))
    if (!existe || !fragmentos.length || !fragmentos.every(escritoPorElDueno)) continue
    const junta = juntas.get(propuesta.id) ?? { fragmentos: [], fuentes: [] }
    for (const fragmento of fragmentos) if (!junta.fragmentos.includes(fragmento)) junta.fragmentos.push(fragmento)
    const fuente = propuesta.fuente.trim()
    if (fuente && !junta.fuentes.includes(fuente)) junta.fuentes.push(fuente)
    juntas.set(propuesta.id, junta)
  }
  for (const [id, { fragmentos, fuentes }] of juntas) {
    estado.entrevista.propuestas[id] = {
      texto: fragmentos.join(`\n\n${SEPARADOR_FRAGMENTOS}\n\n`),
      fuente: fuentes.join(', ') || 'lo que subiste',
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
  // Del material, solo lo escrito: una transcripción automática no vale como cita literal.
  return [...deLaSeccion, instrucciones.textoLiteralDelMaterial(estado)].join('\n')
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
