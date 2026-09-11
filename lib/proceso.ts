import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorArchivo, leerArchivo } from './archivos'
import { avisarTerminado, mandarLinkAlCliente } from './avisos'
import { clienteClaude, ErrorIa, type ClienteIa, type PedidoJson } from './claude'
import {
  buscarPorToken,
  contarCreadosDesde,
  contarLlamadas,
  crearCuestionario,
  ErrorCuestionario,
  estaProcesando,
  fallarProceso,
  guardarEstado,
  registradorDeLlamadas,
  terminarProceso,
  tomarParaProcesar,
  type Cuestionario,
} from './cuestionarios'
import type { EstadoPublico } from './estado-publico'
import { avanzar, ErrorEntrada, mensajeEspera, pantallaActual, progreso, validarEntrada, type Dependencias } from './motor/motor'
import type { ArchivoMaterial, Entrada } from './motor/tipos'
import { leerPlantillaClaude, leerSkill } from './skills'

/**
 * Lo que hacen las rutas de la API: crear, leer, recibir entradas y archivos. Las rutas solo
 * traducen HTTP; todo lo demás está acá.
 */

const LIMITE_TOTAL_BYTES = 150 * 1024 * 1024
const LIMITE_ARCHIVOS = 80

function numeroDeEntorno(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? valor : porDefecto
}

export function carpetaArchivos(cuestionarioId: string): string {
  return join(process.env.DIR_DATOS ?? join(process.cwd(), 'data'), 'archivos', cuestionarioId)
}

export function estadoPublico(cuestionario: Cuestionario): EstadoPublico {
  const procesando = estaProcesando(cuestionario)
  // Candado vencido: el servidor se reinició a mitad de camino. Se ofrece reintentar lo mismo.
  const vencido = cuestionario.procesandoDesde !== null && !procesando
  const error = vencido ? 'Tu última respuesta tardó demasiado en procesarse. Tocá "Reintentar": no se perdió nada.' : cuestionario.ultimoError
  return {
    version: cuestionario.version,
    etapa: cuestionario.estado.etapa,
    procesando,
    mensajeEspera: procesando && cuestionario.entradaPendiente ? mensajeEspera(cuestionario.estado, cuestionario.entradaPendiente) : null,
    error,
    entradaPendiente: error ? cuestionario.entradaPendiente : null,
    progreso: progreso(cuestionario.estado),
    pantalla: pantallaActual(cuestionario.estado),
  }
}

function hash(texto: string): Buffer {
  return createHash('sha256').update(texto).digest()
}

export async function empezarCuestionario(datos: { codigo: string; negocio: string; email: string }): Promise<{ token: string; url: string }> {
  const codigo = process.env.CODIGO_ACCESO?.trim()
  if (!codigo) {
    // En producción sin código cualquiera que encuentre la página gastaría la API.
    if (process.env.NODE_ENV === 'production') {
      throw new ErrorCuestionario('El cuestionario todavía no está habilitado: falta configurar CODIGO_ACCESO.', 403)
    }
  } else if (!timingSafeEqual(hash(datos.codigo.trim()), hash(codigo))) {
    throw new ErrorCuestionario('El link no es válido. Pedile el link de nuevo a quien te lo pasó.', 403)
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
  if (!cuestionario) throw new ErrorCuestionario('Este link no corresponde a ningún cuestionario. Revisá que esté completo.', 404)
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
    throw new ErrorCuestionario('El cuestionario avanzó en otra pestaña. Recargá para seguir desde donde quedó.', 409)
  }
  validarEntrada(cuestionario.estado, entrada)

  const tomado = await tomarParaProcesar(cuestionario, entrada)
  // En segundo plano: el servidor de Next es un proceso que queda vivo, y la pantalla consulta
  // el estado hasta que termine.
  procesar(tomado, entrada).catch((err) => console.error(`[proceso ${tomado.id}] error sin manejar:`, err))
  return estadoPublico(tomado)
}

async function iaConTope(cuestionarioId: string): Promise<ClienteIa> {
  const tope = numeroDeEntorno('TOPE_LLAMADAS_POR_CUESTIONARIO', 600)
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

function dependencias(cuestionarioId: string, ia: ClienteIa): Dependencias {
  return {
    ia,
    skill: leerSkill,
    plantillaClaude: leerPlantillaClaude,
    leerArchivo: (archivo: ArchivoMaterial) => readFile(join(carpetaArchivos(cuestionarioId), archivo.id)),
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

function exigirEtapaConArchivos(cuestionario: Cuestionario): 'pedido_chat' | 'material' {
  if (estaProcesando(cuestionario)) {
    throw new ErrorCuestionario('Esperá a que termine de procesarse tu última respuesta y volvé a subirlo.', 409)
  }
  const etapa = cuestionario.estado.etapa
  if (etapa !== 'pedido_chat' && etapa !== 'material') {
    throw new ErrorCuestionario('En este paso no se pueden subir ni quitar archivos.', 409)
  }
  return etapa
}

export async function subirArchivos(token: string, archivos: File[]): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  const etapa = exigirEtapaConArchivos(cuestionario)
  if (!archivos.length) throw new ErrorCuestionario('No llegó ningún archivo.', 400)
  if (cuestionario.estado.material.archivos.length + archivos.length > LIMITE_ARCHIVOS) {
    throw new ErrorCuestionario(`Se pueden subir hasta ${LIMITE_ARCHIVOS} archivos por cuestionario.`, 400)
  }

  const carpeta = carpetaArchivos(cuestionario.id)
  await mkdir(carpeta, { recursive: true })
  const nuevos: ArchivoMaterial[] = []
  try {
    for (const archivo of archivos) {
      const datos = Buffer.from(await archivo.arrayBuffer())
      let leido
      try {
        leido = leerArchivo(archivo.name, datos)
      } catch (err) {
        if (err instanceof ErrorArchivo) throw new ErrorCuestionario(`${archivo.name}: ${err.message}`, 400)
        throw err
      }
      const id = randomUUID()
      await writeFile(join(carpeta, id), datos)
      nuevos.push({ id, nombre: archivo.name.slice(0, 200), mime: leido.mime, tipo: leido.tipo, bytes: datos.length, texto: leido.texto, etapa })
    }

    const total = [...cuestionario.estado.material.archivos, ...nuevos].reduce((suma, a) => suma + a.bytes, 0)
    if (total > LIMITE_TOTAL_BYTES) {
      throw new ErrorCuestionario('Entre todos los archivos pasan los 150 MB. Quitá alguno o mandá capturas en vez de videos o PDF enormes.', 400)
    }

    const estado = structuredClone(cuestionario.estado)
    estado.material.archivos.push(...nuevos)
    return estadoPublico(await guardarEstado(cuestionario, estado))
  } catch (err) {
    // Lo que no quedó registrado en el estado no puede quedar ocupando disco.
    await Promise.all(nuevos.map((a) => rm(join(carpeta, a.id), { force: true })))
    throw err
  }
}

export async function quitarArchivo(token: string, archivoId: string): Promise<EstadoPublico> {
  const cuestionario = await leerCuestionario(token)
  exigirEtapaConArchivos(cuestionario)
  const archivo = cuestionario.estado.material.archivos.find((a) => a.id === archivoId)
  if (!archivo) throw new ErrorCuestionario('Ese archivo ya no está en el cuestionario.', 404)

  const estado = structuredClone(cuestionario.estado)
  estado.material.archivos = estado.material.archivos.filter((a) => a.id !== archivoId)
  const guardado = await guardarEstado(cuestionario, estado)
  await rm(join(carpetaArchivos(cuestionario.id), archivoId), { force: true })
  return estadoPublico(guardado)
}
