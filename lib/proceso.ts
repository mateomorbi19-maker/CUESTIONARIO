import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ErrorArchivo, expandirZip, hashDeArchivo, leerArchivoDeDisco, tipoDeZip, type ArchivoLeido } from './archivos'
import { avisarTerminado, mandarLinkAlCliente, mandarLinkParaSeguir, puedeMandarLinks } from './avisos'
import { clienteClaude, ErrorIa, type ClienteIa, type PedidoJson } from './claude'
import {
  buscarEmpezadoPorEmail,
  buscarPorToken,
  contarCreadosDesde,
  contarLlamadas,
  crearAcceso,
  crearCuestionario,
  ErrorCuestionario,
  estaProcesando,
  fallarProceso,
  guardarEstado,
  MINUTOS_PLAZO_LECTURA,
  registradorDeLlamadas,
  terminarProceso,
  tomarParaProcesar,
  type Cuestionario,
} from './cuestionarios'
import type { DetalleSubida, EstadoPublico, ParteRecibida, ResultadoSubida, SubidaCreada } from './estado-publico'
import { esChatDeWhatsApp, grupoDeZip, grupoLibre, gruposDeRutas, partesDeRuta, sanearGrupo, sanearNombre } from './grupos'
import { LIMITE_ARCHIVOS, LIMITE_BYTES_ARCHIVO, LIMITE_BYTES_CUESTIONARIO, TAMANO_PARTE } from './limites'
import { esChat, grupoEfectivo } from './motor/material'
import { avanzar, ErrorEntrada, mensajeEspera, pantallaActual, progreso, validarEntrada, type Dependencias } from './motor/motor'
import { PROBLEMA_PDF_PESADO } from './motor/textos'
import type { ArchivoMaterial, Entrada, Pantalla } from './motor/tipos'
import { adelantarTranscripcion, fotogramasDeVideo, imagenParaClaude, transcribirAudio, transcripcionPendiente } from './multimedia'
import { leerPlantillaClaude, leerSkill } from './skills'
import * as subidas from './subidas'

/**
 * Lo que hacen las rutas de la API: crear, leer, recibir entradas y archivos. Las rutas solo
 * traducen HTTP; todo lo demás está acá.
 */

function numeroDeEntorno(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? valor : porDefecto
}

export function carpetaArchivos(cuestionarioId: string): string {
  // turbopackIgnore en los dos join: sin el de adentro el build copia la carpeta data entera (archivos de
  // clientes, modelos) a la imagen, y sin el de afuera busca cualquier carpeta «archivos» del proyecto.
  return join(/*turbopackIgnore: true*/ process.env.DIR_DATOS ?? join(/*turbopackIgnore: true*/ process.cwd(), 'data'), 'archivos', cuestionarioId)
}

/** Donde se guarda, por hash, lo que ya se escuchó o se miró: no se hace dos veces el mismo trabajo. */
function carpetaTranscripciones(cuestionarioId: string): string {
  return join(carpetaArchivos(cuestionarioId), 'transcripciones')
}

/**
 * La pantalla, con una corrección que el motor no puede hacer porque no toca el disco: un audio
 * que figuraba «todavía escuchando» y ya no tiene nada pendiente pasa a 'listo'. La pantalla
 * espera eso para seguir sola, sin que la persona tenga que tocar «Listo, seguir» a ciegas.
 */
function pantallaAlDia(cuestionario: Cuestionario): Pantalla {
  const pantalla = pantallaActual(cuestionario.estado)
  if (pantalla.tipo !== 'material' && pantalla.tipo !== 'pedido_chat') return pantalla
  if (!pantalla.archivos.some((a) => a.estado === 'en_proceso')) return pantalla
  const dirCache = carpetaTranscripciones(cuestionario.id)
  const hashes = new Map(cuestionario.estado.material.archivos.map((a) => [a.id, a.hash]))
  const archivos = pantalla.archivos.map((a) => {
    if (a.estado !== 'en_proceso') return a
    const hash = hashes.get(a.id)
    return hash && transcripcionPendiente(dirCache, hash) ? a : { ...a, estado: 'listo' as const }
  })
  return { ...pantalla, archivos }
}

export function estadoPublico(cuestionario: Cuestionario): EstadoPublico {
  const procesando = estaProcesando(cuestionario)
  // Candado vencido: el servidor se reinició a mitad de camino. Se ofrece reintentar lo mismo.
  const vencido = cuestionario.procesandoDesde !== null && !procesando
  const error = vencido ? 'Tu última respuesta tardó demasiado en procesarse. Tocá "Reintentar": no se perdió nada.' : cuestionario.ultimoError
  return {
    version: cuestionario.version,
    negocio: cuestionario.negocio,
    email: cuestionario.email,
    etapa: cuestionario.estado.etapa,
    procesando,
    mensajeEspera: procesando && cuestionario.entradaPendiente ? mensajeEspera(cuestionario.estado, cuestionario.entradaPendiente) : null,
    error,
    entradaPendiente: error ? cuestionario.entradaPendiente : null,
    progreso: progreso(cuestionario.estado),
    pantalla: pantallaAlDia(cuestionario),
  }
}

function hash(texto: string): Buffer {
  return createHash('sha256').update(texto).digest()
}

/** Nuevo, o el aviso de que ese mail ya tenía uno empezado y se le mandó el link para seguir. */
export type ResultadoInicio = { token: string; url: string } | { retomado: true; email: string }

// Pedir el link de nuevo: tres veces por hora alcanzan para quien lo perdió y frenan a quien quiera
// llenarle la casilla a otro desde el link general. En memoria y no en la base: hay un solo proceso
// y, si se reinicia, que la cuenta empiece de cero no le hace daño a nadie.
const REENVIOS_POR_HORA = 3
const reenvios = new Map<string, number[]>()

function puedeReenviar(email: string): boolean {
  const clave = email.toLowerCase()
  const haceUnaHora = Date.now() - 60 * 60_000
  const recientes = (reenvios.get(clave) ?? []).filter((momento) => momento > haceUnaHora)
  const puede = recientes.length < REENVIOS_POR_HORA
  if (puede) recientes.push(Date.now())
  reenvios.set(clave, recientes)
  return puede
}

export async function empezarCuestionario(datos: { codigo: string; negocio: string; email: string }): Promise<ResultadoInicio> {
  const codigo = process.env.CODIGO_ACCESO?.trim()
  if (!codigo) {
    // En producción sin código cualquiera que encuentre la página gastaría la API.
    if (process.env.NODE_ENV === 'production') {
      throw new ErrorCuestionario('El cuestionario todavía no está habilitado: falta configurar CODIGO_ACCESO.', 403)
    }
  } else if (!timingSafeEqual(hash(datos.codigo.trim()), hash(codigo))) {
    throw new ErrorCuestionario('El link no es válido. Pedile el link de nuevo a quien te lo pasó.', 403)
  }

  // Si ese mail ya tiene uno sin terminar, se le manda el link en vez de abrir otro: empezar de cero
  // en otro dispositivo le haría contestar todo de nuevo. Sin correo no hay cómo mandárselo y se
  // abre uno nuevo, como siempre.
  if (puedeMandarLinks()) {
    const empezado = await buscarEmpezadoPorEmail(datos.email)
    if (empezado) {
      if (!puedeReenviar(empezado.email)) {
        throw new ErrorCuestionario(
          `Ya te mandamos el link a ${empezado.email} hace un rato. Revisá tu mail, también la carpeta de spam.`,
          429,
        )
      }
      const token = await crearAcceso(empezado.id)
      try {
        await mandarLinkParaSeguir(empezado, token)
      } catch (err) {
        console.error(`[link ${empezado.id}] no se pudo mandar el link para seguir:`, err)
        throw new ErrorCuestionario('No pudimos mandarte el mail con el link para seguir. Probá de nuevo en unos minutos.', 503)
      }
      return { retomado: true, email: empezado.email }
    }
  }

  const tope = numeroDeEntorno('TOPE_CUESTIONARIOS_POR_DIA', 20)
  if ((await contarCreadosDesde(new Date(Date.now() - 24 * 60 * 60_000))) >= tope) {
    throw new ErrorCuestionario('Hoy ya se abrieron muchos cuestionarios. Probá de nuevo mañana.', 429)
  }

  const { cuestionario, token } = await crearCuestionario(datos.negocio, datos.email)
  mandarLinkAlCliente(cuestionario.email, cuestionario.negocio, token).catch((err) =>
    console.error(`[link ${cuestionario.id}] no se pudo mandar el link al cliente:`, err),
  )
  return { token, url: `/c/${token}` }
}

export async function leerCuestionario(token: string): Promise<Cuestionario> {
  const cuestionario = await buscarPorToken(token)
  // El único 404 de la API: con él la pantalla da el link por inválido y deja de recordarlo.
  if (!cuestionario) throw new ErrorCuestionario('Este link no corresponde a ningún cuestionario. Revisá que esté completo.', 404, 'link')
  return cuestionario
}

const TIPOS_DE_ENTRADA = new Set<Entrada['tipo']>([
  'respuesta',
  'sin_chat',
  'eleccion',
  'confirmar',
  'corregir',
  'texto_material',
  'quitar_texto',
  'terminar_material',
  'sigue_igual',
  'no_aplica',
  'no_se',
])

/** Lo que llega por HTTP no está tipado: se arma una Entrada válida o se rechaza. */
function comoEntrada(valor: unknown): Entrada {
  const crudo = (valor ?? {}) as Record<string, unknown>
  const tipo = crudo.tipo as Entrada['tipo']
  if (!TIPOS_DE_ENTRADA.has(tipo)) throw new ErrorEntrada('La pantalla mandó algo que no se entiende. Recargá la página.')
  const texto = typeof crudo.texto === 'string' ? crudo.texto.slice(0, 50_000) : ''
  switch (tipo) {
    case 'respuesta':
    case 'corregir':
    case 'texto_material':
    case 'no_aplica':
      return { tipo, texto }
    case 'eleccion':
      return { tipo, opcion: typeof crudo.opcion === 'string' ? crudo.opcion : '' }
    case 'quitar_texto':
      return { tipo, id: typeof crudo.id === 'string' ? crudo.id : '' }
    default:
      return { tipo } as Entrada
  }
}

export async function recibirEntrada(token: string, entradaCruda: unknown, version: unknown): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  const entrada = comoEntrada(entradaCruda)
  if (typeof version !== 'number') throw new ErrorCuestionario('Falta la versión del cuestionario. Recargá la página.', 400)
  if (version !== cuestionario.version) {
    throw new ErrorCuestionario('El cuestionario avanzó en otra pestaña. Recargá para seguir desde donde quedó.', 409, 'version')
  }
  validarEntrada(cuestionario.estado, entrada)

  const tomado = await tomarParaProcesar(cuestionario, entrada)
  // En segundo plano: el servidor de Next es un proceso que queda vivo, y la pantalla consulta
  // el estado hasta que termine.
  procesar(tomado, entrada).catch((err) => console.error(`[proceso ${tomado.id}] error sin manejar:`, err))
  return estadoPublico(tomado)
}

async function iaConTope(cuestionarioId: string): Promise<ClienteIa> {
  // Cada foto y cada video es una llamada: un cuestionario con varias conversaciones enteras pasa las 600 de antes.
  const tope = numeroDeEntorno('TOPE_LLAMADAS_POR_CUESTIONARIO', 1000)
  let hechas = await contarLlamadas(cuestionarioId)
  const base = clienteClaude(registradorDeLlamadas(cuestionarioId))
  return {
    modelo: base.modelo,
    async pedirJson<T>(pedido: PedidoJson): Promise<T> {
      if (hechas >= tope) {
        throw new ErrorIa(`El cuestionario ${cuestionarioId} llegó al tope de ${tope} llamadas a Claude.`, 'tope')
      }
      hechas++
      return base.pedirJson<T>(pedido)
    },
  }
}

async function escribirJson(ruta: string, contenido: unknown): Promise<void> {
  // La carpeta no existe en un volumen que ya tenía datos: se crea antes de escribir.
  await mkdir(dirname(ruta), { recursive: true })
  const temporal = `${ruta}.${randomUUID()}.tmp`
  await writeFile(temporal, JSON.stringify(contenido))
  await rename(temporal, ruta)
}

function dependencias(cuestionarioId: string, ia: ClienteIa): Dependencias {
  const carpeta = carpetaArchivos(cuestionarioId)
  const dirCache = carpetaTranscripciones(cuestionarioId)
  const enDisco = (archivo: ArchivoMaterial) => join(carpeta, archivo.id)
  // Sin hash (un cuestionario empezado antes de guardarlo) no hay con qué nombrar la caché.
  const rutaDeDescripcion = (archivo: ArchivoMaterial) => (archivo.hash ? join(dirCache, `${archivo.hash}.video.json`) : null)
  return {
    ia,
    skill: leerSkill,
    plantillaClaude: leerPlantillaClaude,
    leerArchivo: (archivo) => readFile(enDisco(archivo)),
    imagenParaClaude: (archivo) => imagenParaClaude(enDisco(archivo), archivo.mime),
    transcribirAudio: (archivo) => transcribirAudio(enDisco(archivo), { hash: archivo.hash, dirCache }),
    fotogramasDeVideo: (archivo) => fotogramasDeVideo(enDisco(archivo)),
    plazoMultimediaMs: MINUTOS_PLAZO_LECTURA * 60_000,
    descripcionGuardada: async (archivo) => {
      const ruta = rutaDeDescripcion(archivo)
      if (!ruta) return null
      try {
        const guardada = JSON.parse(await readFile(ruta, 'utf8')) as { descripcion?: unknown }
        return typeof guardada.descripcion === 'string' ? guardada.descripcion : null
      } catch {
        return null
      }
    },
    guardarDescripcion: async (archivo, descripcion) => {
      const ruta = rutaDeDescripcion(archivo)
      if (ruta) await escribirJson(ruta, { descripcion })
    },
  }
}

function mensajeParaElCliente(err: unknown): string {
  if (err instanceof ErrorEntrada) return err.message
  if (err instanceof ErrorIa && err.causa === 'tope') {
    return 'Este cuestionario llegó a su límite de uso. Avisale a quien te pasó el link para que lo habilite.'
  }
  if (err instanceof ErrorIa && err.causa === 'sin_clave') {
    return 'El servicio no está disponible en este momento. Probá de nuevo en un rato: lo que contestaste está guardado.'
  }
  return 'Hubo un problema al procesar tu respuesta. Tocá "Reintentar": lo que contestaste está guardado.'
}

async function procesar(cuestionario: Cuestionario, entrada: Entrada): Promise<void> {
  try {
    const ia = await iaConTope(cuestionario.id)
    const estado = await avanzar(cuestionario.estado, entrada, dependencias(cuestionario.id, ia))
    const guardado = await terminarProceso(cuestionario, estado)
    if (guardado.estado.etapa === 'terminado') await avisarTerminado(guardado)
  } catch (err) {
    console.error(`[proceso ${cuestionario.id}]`, err)
    await fallarProceso(cuestionario.id, mensajeParaElCliente(err)).catch((e) =>
      console.error(`[proceso ${cuestionario.id}] no se pudo guardar el error:`, e),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Archivos y conversaciones
// ---------------------------------------------------------------------------------------------

function exigirEtapaConArchivos(cuestionario: Cuestionario): 'pedido_chat' | 'material' {
  if (estaProcesando(cuestionario)) {
    throw new ErrorCuestionario('Esperá a que termine de procesarse tu última respuesta y volvé a subirlo.', 409, 'procesando')
  }
  const etapa = cuestionario.estado.etapa
  if (etapa !== 'pedido_chat' && etapa !== 'material') {
    throw new ErrorCuestionario('En este paso no se pueden subir ni quitar archivos.', 409, 'etapa')
  }
  return etapa
}

// Un pedido a Claude no puede pasar de 32 MB y el PDF viaja en base64, que ocupa un tercio más.
const LIMITE_BYTES_PDF = 22 * 1024 * 1024
const PRINCIPIO_PARA_DETECTAR_CHAT = 20_000

/** Un archivo que llegó, todavía fuera del material. */
interface Origen {
  /** Dónde está ahora: un temporal o el archivo de partes de una subida. */
  ruta: string
  /** Como lo mandó el navegador. */
  nombre: string
  grupo: string | null
  /** La conversación la eligió la persona; si no, se dedujo de una carpeta. */
  grupoElegido: boolean
}

/** Un archivo ya puesto en la carpeta del cuestionario y leído, a la espera de saber si entra al material. */
interface Candidato {
  id: string
  ruta: string
  nombre: string
  bytes: number
  hash: string
  leido: ArchivoLeido
  esChat: boolean
  grupo: string | null
}

/** Lo que salió de un origen: un archivo suelto, o todo lo que traía un .zip. */
interface Lote {
  candidatos: Candidato[]
  /**
   * Si la conversación destino ya tiene otro chat, el lote va a «Nombre (2)» sin preguntar: cada
   * .zip es siempre una conversación propia, y a un chat suelto el nombre se lo puso el servidor.
   * Si es false, el nombre lo mandó la pantalla y es ella la que tiene que renombrar el lote.
   */
  renombraSolo: boolean
}

/** Lo que hay que deshacer si el pedido no llega a guardarse. */
interface Rastro {
  creados: string[]
  movidos: { de: string; a: string }[]
  omitidos: DetalleSubida['omitidos']
}

function errorDeArchivo(nombre: string, err: unknown): unknown {
  return err instanceof ErrorArchivo ? new ErrorCuestionario(`${nombre}: ${err.message}`, 400) : err
}

async function empiezaComoZip(ruta: string): Promise<boolean> {
  const archivo = await open(ruta, 'r')
  try {
    const cabecera = Buffer.alloc(4)
    const { bytesRead } = await archivo.read(cabecera, 0, 4, 0)
    return bytesRead === 4 && cabecera.toString('latin1') === 'PK\x03\x04'
  } finally {
    await archivo.close()
  }
}

/**
 * ¿Es un .zip de los que se abren? Solo lo que se llama .zip y por dentro es una carpeta de
 * archivos. Un PowerPoint o un documento de Pages también son un zip: abiertos darían una
 * «conversación» llena de XML, así que quedan como un archivo solo.
 */
async function esZipParaAbrir(ruta: string, nombre: string): Promise<boolean> {
  if (!/\.zip$/i.test(nombre) || !(await empiezaComoZip(ruta))) return false
  return (await tipoDeZip(ruta)) === 'contenedor'
}

async function mover(de: string, a: string): Promise<void> {
  try {
    await rename(de, a)
  } catch (err) {
    // Otro disco: pasa si la carpeta de subidas y la de archivos quedan en volúmenes distintos.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(de, a)
    await rm(de, { force: true })
  }
}

async function candidatoDe(ruta: string, id: string, nombreOriginal: string): Promise<Candidato> {
  const nombre = sanearNombre(partesDeRuta(nombreOriginal).at(-1) ?? nombreOriginal)
  const leido = await leerArchivoDeDisco(nombre, ruta)
  const { size: bytes } = await stat(ruta)
  const esChat = leido.tipo === 'texto' && typeof leido.texto === 'string' && esChatDeWhatsApp(leido.texto.slice(0, PRINCIPIO_PARA_DETECTAR_CHAT))
  return { id, ruta, nombre, bytes, hash: await hashDeArchivo(ruta), leido, esChat, grupo: null }
}

/**
 * A qué conversación va cada archivo de un .zip.
 *
 * - Si adentro hay una sola conversación (el .zip plano de WhatsApp, o el de una carpeta): todo
 *   va a la que se pidió; si no se pidió ninguna, a la carpeta de adentro o al nombre del .zip.
 * - Si adentro hay varias (el .zip de la carpeta madre): cada una queda con su nombre, y lo que
 *   está suelto en la raíz queda suelto, o va a la conversación que eligió la persona.
 */
function gruposDeZip(candidatos: Candidato[], rutas: string[], nombreDelZip: string, pedido: string | null, elegido: boolean): (string | null)[] {
  const deducidos = gruposDeRutas(
    rutas,
    candidatos.map((c) => c.esChat),
  )
  if (new Set(deducidos).size <= 1) {
    // «Otros archivos» con un .zip que trae un chat: es una conversación igual, no archivos sueltos.
    const hayChat = candidatos.some((c) => c.esChat)
    const destino = pedido ?? (elegido && !hayChat ? null : (deducidos[0] ?? grupoDeZip(nombreDelZip)))
    return deducidos.map(() => destino)
  }
  return deducidos.map((grupo) => grupo ?? (elegido ? pedido : null))
}

/** Saca todo lo que trae un .zip a la carpeta del cuestionario. Un .zip de adentro se abre un nivel, como conversación propia. */
async function lotesDeZip(origen: Origen, nombre: string, carpeta: string, presupuesto: number, rastro: Rastro): Promise<Lote[]> {
  const pedido = sanearGrupo(origen.grupo)
  const expandido = await expandirZip(origen.ruta, carpeta, { presupuestoBytes: presupuesto })
  rastro.creados.push(...expandido.archivos.map((a) => a.ruta))
  rastro.omitidos.push(...expandido.omitidos)
  if (!expandido.archivos.length && !expandido.omitidos.length) {
    throw new ErrorArchivo('El .zip no trae ningún archivo. Volvé a exportar la conversación y subilo de nuevo.')
  }
  let queda = presupuesto - expandido.archivos.reduce((suma, a) => suma + a.bytes, 0)

  const lotes: Lote[] = []
  const propios: { candidato: Candidato; rutaEnZip: string }[] = []
  for (const archivo of expandido.archivos) {
    const nombreAdentro = partesDeRuta(archivo.rutaEnZip).at(-1) ?? archivo.rutaEnZip
    const anidado = await esZipParaAbrir(archivo.ruta, nombreAdentro).catch(() => false)
    if (!anidado) {
      try {
        propios.push({ candidato: await candidatoDe(archivo.ruta, archivo.id, nombreAdentro), rutaEnZip: archivo.rutaEnZip })
      } catch (err) {
        if (!(err instanceof ErrorArchivo)) throw err
        // Un archivo de adentro que pasa el límite no frena al resto del .zip.
        rastro.omitidos.push({ nombre: archivo.rutaEnZip, motivo: err.message })
        await rm(archivo.ruta, { force: true })
      }
      continue
    }

    // Quien comprime la carpeta con sus tres .zip «para subir todo junto» no pierde ninguno.
    try {
      // El .zip de adentro se borra al abrirlo: su lugar lo ocupa lo que traía.
      const interno = await expandirZip(archivo.ruta, carpeta, { presupuestoBytes: queda + archivo.bytes })
      rastro.creados.push(...interno.archivos.map((a) => a.ruta))
      rastro.omitidos.push(...interno.omitidos.map((o) => ({ nombre: `${archivo.rutaEnZip}/${o.nombre}`, motivo: o.motivo })))
      queda += archivo.bytes - interno.archivos.reduce((suma, a) => suma + a.bytes, 0)
      const candidatos: Candidato[] = []
      const rutas: string[] = []
      for (const adentro of interno.archivos) {
        try {
          candidatos.push(await candidatoDe(adentro.ruta, adentro.id, partesDeRuta(adentro.rutaEnZip).at(-1) ?? adentro.rutaEnZip))
          rutas.push(adentro.rutaEnZip)
        } catch (err) {
          if (!(err instanceof ErrorArchivo)) throw err
          rastro.omitidos.push({ nombre: `${archivo.rutaEnZip}/${adentro.rutaEnZip}`, motivo: err.message })
          await rm(adentro.ruta, { force: true })
        }
      }
      const grupos = gruposDeZip(candidatos, rutas, nombreAdentro, null, false)
      candidatos.forEach((candidato, i) => (candidato.grupo = grupos[i]))
      lotes.push({ candidatos, renombraSolo: true })
    } catch (err) {
      if (!(err instanceof ErrorArchivo)) throw err
      rastro.omitidos.push({ nombre: archivo.rutaEnZip, motivo: err.message })
    }
    await rm(archivo.ruta, { force: true })
  }

  const grupos = gruposDeZip(
    propios.map((p) => p.candidato),
    propios.map((p) => p.rutaEnZip),
    nombre,
    pedido,
    origen.grupoElegido,
  )
  propios.forEach((propio, i) => (propio.candidato.grupo = grupos[i]))
  lotes.unshift({ candidatos: propios.map((p) => p.candidato), renombraSolo: true })
  return lotes
}

/** Pone en la carpeta del cuestionario lo que trae un origen y lo lee. Todavía no toca el estado. */
async function prepararOrigen(origen: Origen, carpeta: string, presupuesto: number, rastro: Rastro): Promise<Lote[]> {
  const nombre = sanearNombre(partesDeRuta(origen.nombre).at(-1) ?? origen.nombre)
  try {
    if (await esZipParaAbrir(origen.ruta, nombre)) return await lotesDeZip(origen, nombre, carpeta, presupuesto, rastro)

    const id = randomUUID()
    const destino = join(carpeta, id)
    await mover(origen.ruta, destino)
    rastro.movidos.push({ de: origen.ruta, a: destino })
    const candidato = await candidatoDe(destino, id, nombre)
    candidato.grupo = sanearGrupo(origen.grupo)
    // En Android el chat exportado suele quedar como archivos sueltos. El .txt del chat arma su
    // propia conversación, con su nombre; las fotos y audios que nombra se le suman solos.
    const chatSuelto = candidato.esChat && candidato.grupo === null
    if (chatSuelto) candidato.grupo = grupoDeZip(nombre)
    return [{ candidatos: [candidato], renombraSolo: chatSuelto }]
  } catch (err) {
    throw errorDeArchivo(nombre, err)
  }
}

function archivoDe(candidato: Candidato, grupo: string | null, etapa: ArchivoMaterial['etapa']): ArchivoMaterial {
  const { leido } = candidato
  const archivo: ArchivoMaterial = {
    id: candidato.id,
    nombre: candidato.nombre,
    mime: leido.mime,
    tipo: leido.tipo,
    bytes: candidato.bytes,
    texto: leido.texto,
    etapa,
    grupo,
    hash: candidato.hash,
  }
  if (leido.problema) archivo.problema = leido.problema
  // Un sticker no dice nada del negocio: no se le paga a Claude por mirarlo.
  if (leido.tipo === 'imagen' && /-STICKER-/i.test(candidato.nombre)) archivo.texto = ''
  if (leido.tipo === 'pdf' && candidato.bytes > LIMITE_BYTES_PDF) {
    archivo.texto = ''
    archivo.problema = PROBLEMA_PDF_PESADO
  }
  return archivo
}

const megas = (bytes: number) => Math.round(bytes / (1024 * 1024))

interface Ubicacion {
  estado: Cuestionario['estado']
  nuevos: { archivo: ArchivoMaterial; ruta: string }[]
  /** Rutas de lo que ya estaba subido: no se guardan de nuevo. */
  repetidos: string[]
  detalle: DetalleSubida
}

/**
 * Decide, contra el estado actual, dónde queda cada archivo: en qué conversación, cuáles ya
 * estaban y si entran en los límites. No toca el disco ni la base: se puede repetir con un estado
 * más nuevo si otra pestaña guardó en el medio.
 */
function ubicar(cuestionario: Cuestionario, lotes: Lote[], omitidos: DetalleSubida['omitidos']): Ubicacion {
  const etapa = exigirEtapaConArchivos(cuestionario)
  const estado = structuredClone(cuestionario.estado)
  const deLaEtapa = estado.material.archivos.filter((a) => a.etapa === etapa)
  // Con la conversación que ve el dueño: un suelto que su chat nombra ya figura en esa conversación.
  const efectivo = grupoEfectivo(deLaEtapa)
  const clave = (grupo: string | null, nombre: string, hash: string) => JSON.stringify([grupo, nombre, hash])

  const yaEstan = new Set<string>()
  const gruposUsados = new Set<string>()
  const chatsDeGrupo = new Map<string, Set<string>>()
  for (const archivo of deLaEtapa) {
    const grupo = efectivo.get(archivo.id) ?? null
    if (archivo.hash) yaEstan.add(clave(grupo, archivo.nombre, archivo.hash))
    if (grupo === null) continue
    gruposUsados.add(grupo)
    if (esChat(archivo)) chatsDeGrupo.set(grupo, (chatsDeGrupo.get(grupo) ?? new Set<string>()).add(archivo.hash ?? archivo.id))
  }

  const nuevos: Ubicacion['nuevos'] = []
  const repetidos: string[] = []
  const grupos = new Set<string | null>()
  for (const lote of lotes) {
    // Las conversaciones no se mezclan: si el destino ya tiene un chat y este lote trae otro
    // distinto, son dos clientes con el mismo nombre de carpeta o de archivo.
    const destinos = new Map<string, string>()
    for (const grupo of new Set(lote.candidatos.map((c) => c.grupo))) {
      if (grupo === null) continue
      const chatsDelLote = lote.candidatos.filter((c) => c.grupo === grupo && c.esChat)
      const chatsQueHay = chatsDeGrupo.get(grupo)
      if (!chatsDelLote.length || !chatsQueHay?.size) continue
      // El mismo chat: es la misma conversación subida de nuevo, y lo repetido se saltea solo.
      if (chatsDelLote.some((c) => chatsQueHay.has(c.hash))) continue
      if (!lote.renombraSolo) {
        throw new ErrorCuestionario(
          `La conversación «${grupo}» ya tiene otro chat. Si es otra conversación, ponele otro nombre; así no se mezclan.`,
          409,
          'grupo_con_otro_chat',
        )
      }
      destinos.set(grupo, grupoLibre(grupo, [...gruposUsados, ...destinos.values()]))
    }

    for (const candidato of lote.candidatos) {
      const grupo = candidato.grupo === null ? null : (destinos.get(candidato.grupo) ?? candidato.grupo)
      grupos.add(grupo)
      const suClave = clave(grupo, candidato.nombre, candidato.hash)
      if (yaEstan.has(suClave)) {
        repetidos.push(candidato.ruta)
        continue
      }
      yaEstan.add(suClave)
      nuevos.push({ archivo: archivoDe(candidato, grupo, etapa), ruta: candidato.ruta })
      if (grupo === null) continue
      gruposUsados.add(grupo)
      if (candidato.esChat) chatsDeGrupo.set(grupo, (chatsDeGrupo.get(grupo) ?? new Set<string>()).add(candidato.hash))
    }
  }

  const cantidad = estado.material.archivos.length + nuevos.length
  if (cantidad > LIMITE_ARCHIVOS) {
    throw new ErrorCuestionario(
      `Se pueden subir hasta ${LIMITE_ARCHIVOS} archivos por cuestionario y con esto serían ${cantidad}. Subí solo las conversaciones que más muestran cómo vendés, o quitá lo que no haga falta.`,
      400,
    )
  }
  const bytes = [...estado.material.archivos, ...nuevos.map((n) => n.archivo)].reduce((suma, a) => suma + a.bytes, 0)
  if (bytes > LIMITE_BYTES_CUESTIONARIO) {
    throw new ErrorCuestionario(
      `Entre todos los archivos pasan los ${megas(LIMITE_BYTES_CUESTIONARIO)} MB. Quitá algún video largo o subí menos conversaciones.`,
      400,
    )
  }

  estado.material.archivos.push(...nuevos.map((n) => n.archivo))
  return { estado, nuevos, repetidos, detalle: { agregados: nuevos.length, repetidos: repetidos.length, omitidos, grupos: [...grupos] } }
}

function bytesUsados(cuestionario: Cuestionario): number {
  return cuestionario.estado.material.archivos.reduce((suma, a) => suma + a.bytes, 0)
}

/**
 * El único camino por el que algo subido entra al material, venga de un formulario o de una
 * subida por partes. Todo el pedido se guarda o no se guarda nada: si algo falla, lo que se puso
 * en el disco se borra y lo que se movió vuelve a su lugar.
 */
async function incorporar(token: string, origenes: Origen[]): Promise<ResultadoSubida> {
  let cuestionario = await leerCuestionario(token)
  exigirEtapaConArchivos(cuestionario)
  if (!origenes.length) throw new ErrorCuestionario('No llegó ningún archivo.', 400)

  const carpeta = carpetaArchivos(cuestionario.id)
  await mkdir(carpeta, { recursive: true })
  const rastro: Rastro = { creados: [], movidos: [], omitidos: [] }
  let registrado = false
  try {
    const lotes: Lote[] = []
    let presupuesto = LIMITE_BYTES_CUESTIONARIO - bytesUsados(cuestionario)
    for (const origen of origenes) {
      const delOrigen = await prepararOrigen(origen, carpeta, presupuesto, rastro)
      presupuesto -= delOrigen.flatMap((lote) => lote.candidatos).reduce((suma, c) => suma + c.bytes, 0)
      lotes.push(...delOrigen)
    }

    for (let intento = 1; ; intento++) {
      const ubicacion = ubicar(cuestionario, lotes, rastro.omitidos)
      let guardado: Cuestionario
      try {
        guardado = await guardarEstado(cuestionario, ubicacion.estado)
      } catch (err) {
        // Otra subida de la misma tanda guardó justo antes: los archivos ya están leídos, así que
        // se vuelve a decidir contra el estado nuevo en vez de hacerle repetir la subida.
        if (intento > 1 || !(err instanceof ErrorCuestionario) || err.motivo !== 'version') throw err
        cuestionario = await leerCuestionario(token)
        continue
      }
      // Desde acá los archivos nuevos son del cuestionario: pase lo que pase, ya no se deshace nada.
      registrado = true
      await Promise.all(ubicacion.repetidos.map((ruta) => rm(ruta, { force: true }).catch(() => undefined)))
      const dirCache = carpetaTranscripciones(cuestionario.id)
      for (const { archivo, ruta } of ubicacion.nuevos) {
        if (archivo.texto === null && (archivo.tipo === 'audio' || archivo.tipo === 'video')) {
          adelantarTranscripcion(ruta, { hash: archivo.hash, dirCache })
        }
      }
      return { ...estadoPublico(guardado), subida: ubicacion.detalle }
    }
  } catch (err) {
    if (registrado) throw err
    // Lo que no quedó registrado en el estado no puede quedar ocupando disco.
    const vueltos = new Set<string>()
    for (const { de, a } of rastro.movidos) {
      await mover(a, de)
        .then(() => vueltos.add(a))
        .catch(() => undefined)
    }
    await Promise.all(rastro.creados.filter((ruta) => !vueltos.has(ruta)).map((ruta) => rm(ruta, { force: true })))
    await Promise.all(rastro.movidos.filter(({ a }) => !vueltos.has(a)).map(({ a }) => rm(a, { force: true })))
    throw err
  }
}

/**
 * Archivos que llegaron enteros en un pedido. `grupo` es la conversación (null: sueltos) y
 * `grupoElegido` dice si la eligió la persona o se dedujo de la carpeta.
 */
export async function subirArchivos(token: string, archivos: File[], grupo: string | null = null, grupoElegido = false): Promise<ResultadoSubida> {
  const cuestionario = await leerCuestionario(token)
  exigirEtapaConArchivos(cuestionario)
  if (!archivos.length) throw new ErrorCuestionario('No llegó ningún archivo.', 400)

  const temporales: string[] = []
  try {
    const origenes: Origen[] = []
    for (const archivo of archivos) {
      if (archivo.size === 0) throw new ErrorCuestionario(`${archivo.name}: El archivo está vacío. Volvé a guardarlo o exportarlo y subilo de nuevo.`, 400)
      const ruta = await subidas.rutaTemporal(cuestionario.id)
      temporales.push(ruta)
      await writeFile(ruta, Buffer.from(await archivo.arrayBuffer()))
      origenes.push({ ruta, nombre: archivo.name, grupo, grupoElegido })
    }
    return await incorporar(token, origenes)
  } finally {
    await Promise.all(temporales.map((ruta) => rm(ruta, { force: true })))
  }
}

export async function crearSubida(token: string, cuerpo: unknown): Promise<SubidaCreada> {
  const cuestionario = await leerCuestionario(token)
  exigirEtapaConArchivos(cuestionario)
  const crudo = (cuerpo ?? {}) as Record<string, unknown>
  const nombre = typeof crudo.nombre === 'string' ? crudo.nombre.trim().slice(0, 1000) : ''
  if (!nombre) throw new ErrorCuestionario('Falta el nombre del archivo. Volvé a elegirlo y subilo de nuevo.', 400)
  const bytes = crudo.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    throw new ErrorCuestionario('La pantalla no mandó el tamaño del archivo. Recargá la página y subilo de nuevo.', 400)
  }
  if (bytes === 0) throw new ErrorCuestionario(`${nombre}: El archivo está vacío. Volvé a guardarlo o exportarlo y subilo de nuevo.`, 400)
  if (bytes > LIMITE_BYTES_ARCHIVO) {
    throw new ErrorCuestionario(
      `${nombre}: pesa más de ${megas(LIMITE_BYTES_ARCHIVO)} MB. Si es un video, mandá uno más corto; si es un .zip, exportá cada conversación por separado.`,
      400,
    )
  }
  const datos = {
    nombre,
    bytes,
    grupo: sanearGrupo(typeof crudo.grupo === 'string' ? crudo.grupo : null),
    grupoElegido: crudo.grupoElegido === true,
  }

  // La misma subida que quedó a medias (se recargó la página, el celular cerró la pestaña): se sigue desde ahí.
  const abierta = await subidas.subidaAbierta(cuestionario.id, datos)
  if (abierta) return { id: abierta.id, recibidos: await subidas.bytesRecibidos(cuestionario.id, abierta.id), tamanoParte: TAMANO_PARTE }

  if (cuestionario.estado.material.archivos.length >= LIMITE_ARCHIVOS) {
    throw new ErrorCuestionario(`Ya hay ${LIMITE_ARCHIVOS} archivos, que es el máximo por cuestionario. Quitá lo que no haga falta antes de subir más.`, 400)
  }
  const ocupado = bytesUsados(cuestionario) + (await subidas.bytesAbiertos(cuestionario.id))
  if (ocupado + bytes > LIMITE_BYTES_CUESTIONARIO) {
    throw new ErrorCuestionario(
      `Con este archivo se pasan los ${megas(LIMITE_BYTES_CUESTIONARIO)} MB del cuestionario. Esperá a que terminen las otras subidas o quitá algún video largo.`,
      400,
    )
  }
  const subida = await subidas.crearSubida(cuestionario.id, datos)
  return { id: subida.id, recibidos: 0, tamanoParte: TAMANO_PARTE }
}

export async function recibirParte(token: string, id: string, desde: number, datos: Buffer): Promise<ParteRecibida> {
  const cuestionario = await leerCuestionario(token)
  if (!Number.isInteger(desde) || desde < 0) {
    throw new ErrorCuestionario('La parte no dice desde dónde va. Recargá la página y subí el archivo de nuevo.', 400)
  }
  if (datos.length === 0) throw new ErrorCuestionario('La parte llegó vacía. Probá de nuevo.', 400)
  if (datos.length > TAMANO_PARTE) {
    throw new ErrorCuestionario('La parte que se mandó es demasiado grande. Recargá la página y probá de nuevo.', 400)
  }
  return { recibidos: await subidas.recibirParte(cuestionario.id, id, desde, datos) }
}

// Dos pedidos de terminar a la vez (la pantalla reintenta si el primero tarda) abrirían el mismo
// .zip dos veces. El segundo espera al primero y recibe lo mismo. En globalThis, porque Next puede
// cargar este módulo más de una vez.
const compartido = globalThis as unknown as { __terminando?: Map<string, Promise<ResultadoSubida>> }

export function terminarSubida(token: string, id: string): Promise<ResultadoSubida> {
  const terminando = (compartido.__terminando ??= new Map())
  const enCurso = terminando.get(id)
  if (enCurso) return enCurso
  const trabajo = terminarSinCandado(token, id).finally(() => terminando.delete(id))
  terminando.set(id, trabajo)
  return trabajo
}

async function terminarSinCandado(token: string, id: string): Promise<ResultadoSubida> {
  const cuestionario = await leerCuestionario(token)
  const subida = await subidas.leerSubida(cuestionario.id, id)
  // Repetirlo después de un éxito devuelve lo mismo, con el estado de ahora.
  if (subida.terminada && subida.resultado) return { ...estadoPublico(cuestionario), subida: subida.resultado }
  exigirEtapaConArchivos(cuestionario)

  const ruta = subidas.rutaDeParte(cuestionario.id, id)
  const info = await stat(ruta).catch(() => null)
  if (!info) {
    // El servidor se cortó después de guardar el archivo y antes de anotarlo: ya está en el
    // material. Sin esto, la pantalla volvería a subir el archivo entero.
    const nombre = sanearNombre(partesDeRuta(subida.nombre).at(-1) ?? subida.nombre)
    const guardado = cuestionario.estado.material.archivos.find((a) => a.nombre === nombre && a.bytes === subida.bytes)
    if (!guardado) throw new ErrorCuestionario('Esa subida venció o ya no existe. Volvé a subir el archivo.', 410, 'subida_vencida')
    const detalle: DetalleSubida = { agregados: 1, repetidos: 0, omitidos: [], grupos: [guardado.grupo ?? null] }
    await subidas.marcarTerminada(cuestionario.id, id, detalle)
    return { ...estadoPublico(cuestionario), subida: detalle }
  }
  if (info.size !== subida.bytes) {
    throw new ErrorCuestionario('Todavía faltan partes del archivo. La subida sigue desde donde quedó.', 409, 'faltan_bytes', { recibidos: info.size })
  }

  const resultado = await incorporar(token, [{ ruta, nombre: subida.nombre, grupo: subida.grupo, grupoElegido: subida.grupoElegido }])
  await subidas.marcarTerminada(cuestionario.id, id, resultado.subida)
  return resultado
}

/** Cancela una subida por partes y borra lo recibido. */
export async function cancelarSubida(token: string, id: string): Promise<void> {
  const cuestionario = await leerCuestionario(token)
  await subidas.cancelarSubida(cuestionario.id, id)
}

export async function quitarArchivo(token: string, archivoId: string): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  exigirEtapaConArchivos(cuestionario)
  const archivo = cuestionario.estado.material.archivos.find((a) => a.id === archivoId)
  // 409 y no 404: un doble toque en «Quitar» no puede dejar a la persona afuera del cuestionario.
  if (!archivo) throw new ErrorCuestionario('Ese archivo ya no está en el cuestionario.', 409, 'ya_no_esta')

  const estado = structuredClone(cuestionario.estado)
  estado.material.archivos = estado.material.archivos.filter((a) => a.id !== archivoId)
  const guardado = await guardarEstado(cuestionario, estado)
  await borrarDelDisco(cuestionario.id, [archivoId])
  return estadoPublico(guardado)
}

/**
 * Borra archivos que ya no están en el estado. Si alguno no se puede borrar (en Windows, mientras
 * ffmpeg lo está leyendo para adelantar la transcripción), queda huérfano y se avisa en el
 * registro: el cambio ya se guardó y la persona no tiene que ver un error por eso.
 */
async function borrarDelDisco(cuestionarioId: string, ids: string[]): Promise<void> {
  const carpeta = carpetaArchivos(cuestionarioId)
  await Promise.all(
    ids.map((id) => rm(join(carpeta, id), { force: true }).catch((err) => console.error(`[archivos ${cuestionarioId}] no se pudo borrar ${id}:`, err))),
  )
}

/** Los archivos de una conversación en la etapa actual, tal como la ve el dueño. `grupo` null: los sueltos. */
function archivosDeConversacion(cuestionario: Cuestionario, etapa: ArchivoMaterial['etapa'], grupo: string | null): ArchivoMaterial[] {
  const deLaEtapa = cuestionario.estado.material.archivos.filter((a) => a.etapa === etapa)
  const efectivo = grupoEfectivo(deLaEtapa)
  return deLaEtapa.filter((a) => (efectivo.get(a.id) ?? null) === grupo)
}

/** Quita una conversación entera, con todos sus archivos. */
export async function quitarConversacion(token: string, grupo: string | null): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  const etapa = exigirEtapaConArchivos(cuestionario)
  const fuera = new Set(archivosDeConversacion(cuestionario, etapa, grupo).map((a) => a.id))
  if (!fuera.size) throw new ErrorCuestionario('Esa conversación ya no está en el cuestionario.', 409, 'ya_no_esta')

  const estado = structuredClone(cuestionario.estado)
  estado.material.archivos = estado.material.archivos.filter((a) => !fuera.has(a.id))
  const guardado = await guardarEstado(cuestionario, estado)
  // Después de guardar: si guardar falla, los archivos tienen que seguir en el disco.
  await borrarDelDisco(cuestionario.id, [...fuera])
  await subidas.borrarSubidasDeGrupo(cuestionario.id, grupo).catch((err) => console.error('[subidas] no se pudieron borrar las subidas a medias:', err))
  return estadoPublico(guardado)
}

export async function renombrarConversacion(token: string, grupo: unknown, nombre: unknown): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  const etapa = exigirEtapaConArchivos(cuestionario)
  if (typeof grupo !== 'string' || !grupo) throw new ErrorCuestionario('Falta decir qué conversación se renombra. Recargá la página.', 400)
  const nuevo = sanearGrupo(typeof nombre === 'string' ? nombre : null)
  if (!nuevo) throw new ErrorCuestionario('El nombre está vacío: escribí cómo reconocés esa conversación.', 400)

  const suyos = new Set(archivosDeConversacion(cuestionario, etapa, grupo).map((a) => a.id))
  if (!suyos.size) throw new ErrorCuestionario('Esa conversación ya no está en el cuestionario.', 409, 'ya_no_esta')
  if (nuevo === grupo) return estadoPublico(cuestionario)
  // Con el mismo nombre que otra, las dos se juntarían en una.
  if (archivosDeConversacion(cuestionario, etapa, nuevo).length) {
    throw new ErrorCuestionario('Ya hay otra conversación con ese nombre. Elegí otro para que no se mezclen.', 400)
  }

  const estado = structuredClone(cuestionario.estado)
  for (const archivo of estado.material.archivos) if (suyos.has(archivo.id)) archivo.grupo = nuevo
  const guardado = await guardarEstado(cuestionario, estado)
  await subidas.renombrarGrupoDeSubidas(cuestionario.id, grupo, nuevo).catch((err) => console.error('[subidas] no se pudieron renombrar las subidas a medias:', err))
  return estadoPublico(guardado)
}
