import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ArrastreReact,
  type ReactNode,
} from 'react'
import { problemaDeArchivo } from '@/lib/cliente-api'
import { grupoLibre, sanearNombre } from '@/lib/grupos'
import { LIMITE_ARCHIVOS } from '@/lib/limites'
import type { ArchivoPublico, Pantalla } from '@/lib/motor/tipos'
import { Boton } from './Boton'
import { useCuestionario, type AccionesCuestionario, type ResultadoUi } from './Contexto'
import { IconoArchivo, IconoCarpeta, IconoChat, IconoSubir } from './Iconos'
import {
  archivosDelSelector,
  archivosSoltados,
  conGrupos,
  esZip,
  pareceDeWhatsApp,
  type ArchivoConRuta,
  type ArchivoParaSubir,
} from './leerCarpetas'

/**
 * Subir archivos: una sola fila para todo el cuestionario.
 *
 * La zona de arriba, «Armar una conversación» y el «Agregar» de cada tarjeta encolan en
 * el mismo lugar (`ProveedorDeSubidas`) y se sube de a un archivo, en orden: cada respuesta trae
 * el estado entero y dos a la vez se pisarían. El proveedor va por encima del cambio de vistas
 * (en `Cuestionario`), así lo que falló sigue ahí con su «Reintentar» después de una espera.
 */

const MENSAJE_DEMASIADOS = `Son demasiados archivos juntos: en total entran ${LIMITE_ARCHIVOS}. Subí solo las conversaciones que pide la lista, no toda la carpeta del negocio.`
const MENSAJE_SIN_ARCHIVOS = 'No encontramos archivos para subir en lo que elegiste.'
const MENSAJE_NO_SE_LEYO =
  'No pudimos leer lo que elegiste. Probá de nuevo; si es una carpeta, también podés comprimirla y subir el .zip.'

// Un chat distinto en una conversación que ya tiene el suyo: el lote pasa a «Nombre (2)». Más de
// esto sería dar vueltas: algo anda mal y conviene mostrar el error.
const MAXIMO_CAMBIOS_DE_NOMBRE = 3
const MAXIMO_AVISOS = 6

export interface FallaDeSubida {
  clave: number
  nombre: string
  error: string
  /** false: está vacío o pesa demasiado, y reintentar daría lo mismo. */
  reintentable: boolean
}

/** Una tanda de archivos que van al mismo lugar. Es una fila del panel, con su avance. */
export interface Lote {
  clave: number
  /** La conversación destino. null: archivos sueltos, o un .zip que arma la suya. */
  grupo: string | null
  /** El nombre del .zip cuando va sin conversación: el servidor arma una con ese nombre. */
  zip: string | null
  total: number
  hechos: number
  /** Ya empezó a subir. Antes de eso está en fila, detrás de otro lote. */
  subiendo: boolean
  bytesTotales: number
  /** De los archivos que ya terminaron. */
  bytesEnviados: number
  /** Del archivo que está subiendo ahora. */
  bytesDelActual: number
  errores: FallaDeSubida[]
  agregados: number
  repetidos: number
  omitidos: { nombre: string; motivo: string }[]
}

interface AvisoDeSubida {
  clave: number
  texto: string
}

interface Tarea {
  clave: number
  lote: number
  archivo: File
  grupo: string | null
  grupoElegido: boolean
  /** Cuántas veces se la pasó a «Nombre (2)» por chocar con otro chat. */
  cambios: number
  control: AbortController | null
}

interface Subidas {
  lotes: Lote[]
  avisos: AvisoDeSubida[]
  /** Lo último que terminó, para los lectores de pantalla. */
  anuncio: string
  /** Hay archivos subiendo o en fila: mientras tanto no conviene seguir ni quitar nada. */
  activos: boolean
  /** Archivos que no se subieron y siguen a la vista con su error. */
  fallidos: number
  encolar: (archivos: ArchivoParaSubir[]) => void
  reintentar: (clave: number) => void
  cerrarFalla: (clave: number) => void
  cancelarLote: (clave: number) => void
  avisar: (texto: string) => void
  cerrarAvisos: () => void
  /** Después de cambiarle el nombre a una conversación: lo que falta subir va al nombre nuevo. */
  renombrarGrupo: (grupo: string, nombre: string) => void
  /** Después de quitar una conversación: lo que quedaba por subir o reintentar ya no va. */
  cancelarGrupo: (grupo: string | null) => void
  /** Los nombres de conversación que ya están en pantalla o en camino. */
  gruposEnUso: () => string[]
}

const ContextoSubidas = createContext<Subidas | null>(null)

export function useSubidas(): Subidas {
  const subidas = useContext(ContextoSubidas)
  if (!subidas) throw new Error('Lo que sube archivos va dentro de <ProveedorDeSubidas>.')
  return subidas
}

function pendientesDe(lote: Lote): number {
  return lote.total - lote.hechos - lote.errores.length
}

function archivosDe(pantalla: Pantalla): ArchivoPublico[] {
  return pantalla.tipo === 'material' || pantalla.tipo === 'pedido_chat' ? pantalla.archivos : []
}

function nombreDeLote(lote: Lote): string {
  if (lote.zip) return `«${lote.zip}»`
  return lote.grupo ? `«${lote.grupo}»` : 'otros archivos'
}

function cuantosArchivos(n: number): string {
  return n === 1 ? '1 archivo' : `${n} archivos`
}

/** Lo que conviene saber de un lote que terminó: qué no se agregó y por qué. null si no hay nada. */
function resumenDeLote(lote: Lote): string | null {
  const partes: string[] = []
  if (lote.repetidos === 1) partes.push('1 archivo ya estaba subido y no lo agregamos de nuevo.')
  if (lote.repetidos > 1) {
    partes.push(`${lote.repetidos} archivos ya estaban subidos y no los agregamos de nuevo.`)
  }
  if (lote.omitidos.length > 0) {
    const nombres = lote.omitidos.slice(0, 3).map((omitido) => `${omitido.nombre} (${omitido.motivo})`)
    const resto = lote.omitidos.length - nombres.length
    partes.push(
      `No pudimos sacar ${cuantosArchivos(lote.omitidos.length)} del .zip: ${nombres.join(', ')}${resto > 0 ? ` y ${resto} más` : ''}.`,
    )
  }
  if (partes.length === 0) return null
  const donde = nombreDeLote(lote)
  return `${donde[0].toUpperCase()}${donde.slice(1)}: ${partes.join(' ')}`
}

/**
 * ¿Lo que ya está subido en esa conversación es parte de lo que se está por subir? Si todo lo
 * que hay en pantalla viene también en la tanda (mismo nombre y mismo peso), es la misma
 * conversación elegida de nuevo: va al mismo lugar, el servidor saltea lo repetido y se completa
 * lo que faltaba. Si hay algo que la tanda no trae, es otra con el mismo nombre.
 */
function esLaMisma(subidos: ArchivoPublico[], tanda: ArchivoParaSubir[]): boolean {
  const huella = (nombre: string, bytes: number) => `${nombre}\n${bytes}`
  const deLaTanda = new Set(tanda.map(({ archivo }) => huella(sanearNombre(archivo.name), archivo.size)))
  return subidos.every((subido) => deLaTanda.has(huella(subido.nombre, subido.bytes)))
}

/**
 * Dos conversaciones distintas con el mismo nombre no se mezclan: si el nombre que salió de una
 * carpeta ya está en pantalla o en camino, toda la conversación de esta tanda pasa a «Nombre (2)».
 * Solo para nombres deducidos: el que la persona eligió («Agregar») se respeta.
 */
function sinChoques(
  tanda: ArchivoParaSubir[],
  enPantalla: ArchivoPublico[],
  lotes: Lote[],
): ArchivoParaSubir[] {
  const esDeducido = (item: ArchivoParaSubir) => !item.grupoElegido && item.grupo !== null
  const deducidos = new Set(tanda.filter(esDeducido).map((item) => item.grupo as string))
  const usados = new Set<string | null>([
    ...enPantalla.map((archivo) => archivo.grupo),
    ...lotes.map((lote) => lote.grupo),
    ...deducidos,
  ])
  const cambios = new Map<string, string>()
  for (const grupo of deducidos) {
    const subidos = enPantalla.filter((archivo) => archivo.grupo === grupo)
    // Con otra tanda todavía subiendo ahí no hay contra qué comparar: ante la duda, se separa.
    const enCamino = lotes.some((lote) => lote.grupo === grupo && pendientesDe(lote) > 0)
    if (!enCamino && subidos.length === 0) continue
    const deEstaTanda = tanda.filter((item) => esDeducido(item) && item.grupo === grupo)
    if (!enCamino && esLaMisma(subidos, deEstaTanda)) continue
    const libre = grupoLibre(grupo, usados)
    usados.add(libre)
    cambios.set(grupo, libre)
  }
  if (cambios.size === 0) return tanda
  return tanda.map((item) => {
    const nuevo = esDeducido(item) ? cambios.get(item.grupo as string) : undefined
    return nuevo ? { ...item, grupo: nuevo } : item
  })
}

interface PropsProveedor {
  acciones: Pick<AccionesCuestionario, 'subirArchivo' | 'descartarSubida'>
  /** La pantalla actual: de ahí salen los archivos ya subidos y si el paso todavía admite archivos. */
  pantalla: Pantalla
  /** Galería de /demo: lotes de muestra para ver el panel sin subir nada. */
  lotesIniciales?: Lote[]
  children: ReactNode
}

export function ProveedorDeSubidas({ acciones, pantalla, lotesIniciales, children }: PropsProveedor) {
  const [lotes, setLotes] = useState<Lote[]>(lotesIniciales ?? [])
  const [avisos, setAvisos] = useState<AvisoDeSubida[]>([])
  const [anuncio, setAnuncio] = useState('')
  const [trabajando, setTrabajando] = useState(false)

  // La fila se maneja desde funciones que siguen corriendo entre un render y otro (una subida
  // puede durar minutos): la verdad está en estas refs y el estado de arriba es su copia a la vista.
  const lotesRef = useRef(lotes)
  const fila = useRef<Tarea[]>([])
  const fallidas = useRef(new Map<number, Tarea>())
  const enCurso = useRef<Tarea | null>(null)
  const corriendo = useRef(false)
  // Arranca alto: los lotes de muestra de la galería usan claves chicas.
  const contador = useRef(1000)
  const accionesRef = useRef(acciones)
  const archivosRef = useRef(archivosDe(pantalla))
  useEffect(() => {
    accionesRef.current = acciones
    archivosRef.current = archivosDe(pantalla)
  })

  const cambiar = useCallback((cambio: (lotes: Lote[]) => Lote[]) => {
    lotesRef.current = cambio(lotesRef.current)
    setLotes(lotesRef.current)
  }, [])

  const cambiarLote = useCallback(
    (clave: number, cambio: (lote: Lote) => Lote) => {
      cambiar((lista) => lista.map((lote) => (lote.clave === clave ? cambio(lote) : lote)))
    },
    [cambiar],
  )

  const avisar = useCallback((texto: string) => {
    // El mismo aviso dos veces no suma nada, y más que unos pocos ya nadie los lee.
    setAvisos((lista) =>
      [...lista.filter((aviso) => aviso.texto !== texto), { clave: ++contador.current, texto }].slice(-MAXIMO_AVISOS),
    )
  }, [])

  const cerrarAvisos = useCallback(() => setAvisos([]), [])

  /** Un lote sin nada pendiente ni fallado sale del panel y deja su resumen, si hay algo que contar. */
  const cerrarSiTermino = useCallback(
    (clave: number) => {
      const lote = lotesRef.current.find((candidato) => candidato.clave === clave)
      if (!lote || pendientesDe(lote) > 0 || lote.errores.length > 0) return
      cambiar((lista) => lista.filter((otro) => otro.clave !== clave))
      const resumen = resumenDeLote(lote)
      if (resumen) avisar(resumen)
      if (lote.agregados > 0) {
        setAnuncio(`Listo: ${cuantosArchivos(lote.agregados)} en ${nombreDeLote(lote)}.`)
      }
    },
    [cambiar, avisar],
  )

  const gruposEnUso = useCallback((): string[] => {
    const nombres = new Set<string>()
    for (const archivo of archivosRef.current) if (archivo.grupo) nombres.add(archivo.grupo)
    for (const lote of lotesRef.current) if (lote.grupo) nombres.add(lote.grupo)
    return [...nombres]
  }, [])

  const anotarFalla = useCallback(
    (tarea: Tarea, error: string) => {
      fallidas.current.set(tarea.clave, tarea)
      const falla: FallaDeSubida = { clave: tarea.clave, nombre: tarea.archivo.name, error, reintentable: true }
      cambiarLote(tarea.lote, (lote) => ({
        ...lote,
        // Lo que falló no cuenta para el porcentaje de lo que sigue subiendo.
        bytesTotales: lote.bytesTotales - tarea.archivo.size,
        bytesDelActual: 0,
        errores: [...lote.errores, falla],
      }))
    },
    [cambiarLote],
  )

  const subirUna = useCallback(
    async (tarea: Tarea) => {
      const control = new AbortController()
      tarea.control = control
      enCurso.current = tarea
      const peso = tarea.archivo.size
      cambiarLote(tarea.lote, (lote) => ({ ...lote, subiendo: true, bytesDelActual: 0 }))

      let resultado: ResultadoUi
      try {
        resultado = await accionesRef.current.subirArchivo(
          tarea.archivo,
          { grupo: tarea.grupo, grupoElegido: tarea.grupoElegido },
          {
            senal: control.signal,
            alProgresar: (enviados) => {
              cambiarLote(tarea.lote, (lote) => ({ ...lote, bytesDelActual: enviados }))
            },
          },
        )
      } catch {
        resultado = { ok: false, error: `«${tarea.archivo.name}» no se subió. Tocá «Reintentar».` }
      }
      enCurso.current = null
      tarea.control = null

      if (control.signal.aborted) {
        // La cancelaron: el lote ya no está. Lo que el servidor haya recibido se borra.
        if (!resultado.ok) accionesRef.current.descartarSubida(tarea.archivo)
        return
      }

      if (resultado.ok) {
        const { agregados, repetidos, omitidos } = resultado
        cambiarLote(tarea.lote, (lote) => ({
          ...lote,
          hechos: lote.hechos + 1,
          bytesEnviados: lote.bytesEnviados + peso,
          bytesDelActual: 0,
          agregados: lote.agregados + agregados,
          repetidos: lote.repetidos + repetidos,
          omitidos: [...lote.omitidos, ...omitidos],
        }))
        cerrarSiTermino(tarea.lote)
        return
      }

      if (
        resultado.motivo === 'grupo_con_otro_chat' &&
        tarea.grupo !== null &&
        tarea.cambios < MAXIMO_CAMBIOS_DE_NOMBRE
      ) {
        // Esa conversación ya tiene otro chat: es otra con el mismo nombre. Este archivo y lo que
        // falta del lote van a «Nombre (2)». El chat se sube primero, así que el choque salta al
        // principio y el lote entero queda junto.
        const anterior = tarea.grupo
        const libre = grupoLibre(anterior, gruposEnUso())
        // La subida abierta quedó anotada para la conversación vieja: se empieza otra.
        accionesRef.current.descartarSubida(tarea.archivo)
        for (const otra of [...fila.current, ...fallidas.current.values()]) {
          if (otra.lote === tarea.lote && otra.grupo === anterior) otra.grupo = libre
        }
        tarea.grupo = libre
        tarea.cambios += 1
        cambiarLote(tarea.lote, (lote) => ({ ...lote, grupo: libre, bytesDelActual: 0 }))
        fila.current.unshift(tarea)
        return
      }

      anotarFalla(tarea, resultado.error)
      if (resultado.motivo === 'procesando' || resultado.motivo === 'etapa') {
        // El cuestionario ya no está recibiendo archivos. Probar con cada uno de los que faltan
        // daría lo mismo, de a uno: quedan todos con el mismo aviso y su «Reintentar».
        const resto = fila.current
        fila.current = []
        for (const otra of resto) anotarFalla(otra, resultado.error)
      }
    },
    [anotarFalla, cambiarLote, cerrarSiTermino, gruposEnUso],
  )

  const bombear = useCallback(async () => {
    if (corriendo.current) return
    corriendo.current = true
    setTrabajando(true)
    try {
      for (let tarea = fila.current.shift(); tarea; tarea = fila.current.shift()) {
        await subirUna(tarea)
      }
    } finally {
      corriendo.current = false
      setTrabajando(false)
    }
  }, [subirUna])

  const encolar = useCallback(
    (archivos: ArchivoParaSubir[]) => {
      if (archivos.length === 0) return
      const enCamino = fila.current.length + (enCurso.current ? 1 : 0)
      if (archivosRef.current.length + enCamino + archivos.length > LIMITE_ARCHIVOS) {
        avisar(MENSAJE_DEMASIADOS)
        return
      }

      const tanda = sinChoques(archivos, archivosRef.current, lotesRef.current)
      const nuevos = new Map<string, { lote: Lote; tareas: Tarea[] }>()
      tanda.forEach((item, i) => {
        const { archivo, grupo } = item
        // Un .zip sin conversación arma la suya: va en su propia fila, con su nombre.
        const zipSolo = grupo === null && esZip(archivo.name)
        const destino = zipSolo ? `zip:${i}` : grupo === null ? 'sueltos' : `grupo:${grupo}`
        let nuevo = nuevos.get(destino)
        if (!nuevo) {
          const lote: Lote = {
            clave: ++contador.current,
            grupo,
            zip: zipSolo ? archivo.name : null,
            total: 0,
            hechos: 0,
            subiendo: false,
            bytesTotales: 0,
            bytesEnviados: 0,
            bytesDelActual: 0,
            errores: [],
            agregados: 0,
            repetidos: 0,
            omitidos: [],
          }
          nuevo = { lote, tareas: [] }
          nuevos.set(destino, nuevo)
        }
        const clave = ++contador.current
        nuevo.lote.total += 1
        const problema = problemaDeArchivo(archivo)
        if (problema) {
          nuevo.lote.errores.push({ clave, nombre: archivo.name, error: problema, reintentable: false })
          return
        }
        nuevo.lote.bytesTotales += archivo.size
        const tarea: Tarea = {
          clave,
          lote: nuevo.lote.clave,
          archivo,
          grupo,
          grupoElegido: item.grupoElegido,
          cambios: 0,
          control: null,
        }
        // El chat va primero: la tarjeta aparece con su chat, y si esa conversación ya tenía otro,
        // el servidor lo dice antes de que suba el resto.
        if (item.esChat || /\.txt$/i.test(archivo.name)) {
          const primerAdjunto = nuevo.tareas.findIndex((otra) => !/\.txt$/i.test(otra.archivo.name))
          nuevo.tareas.splice(primerAdjunto === -1 ? nuevo.tareas.length : primerAdjunto, 0, tarea)
        } else {
          nuevo.tareas.push(tarea)
        }
      })

      cambiar((lista) => [...lista, ...[...nuevos.values()].map(({ lote }) => lote)])
      for (const { tareas } of nuevos.values()) fila.current.push(...tareas)
      void bombear()
    },
    [avisar, bombear, cambiar],
  )

  const loteDeFalla = useCallback((clave: number): Lote | undefined => {
    return lotesRef.current.find((lote) => lote.errores.some((falla) => falla.clave === clave))
  }, [])

  const reintentar = useCallback(
    (clave: number) => {
      const lote = loteDeFalla(clave)
      if (!lote) return
      const tarea = fallidas.current.get(clave)
      fallidas.current.delete(clave)
      cambiarLote(lote.clave, (actual) => ({
        ...actual,
        // Sin tarea detrás (los lotes de muestra de la galería) no hay qué subir: se da por cerrada.
        total: tarea ? actual.total : actual.total - 1,
        bytesTotales: actual.bytesTotales + (tarea?.archivo.size ?? 0),
        errores: actual.errores.filter((falla) => falla.clave !== clave),
      }))
      if (!tarea) {
        cerrarSiTermino(lote.clave)
        return
      }
      // Adelante de la fila: es lo que la persona está mirando.
      fila.current.unshift(tarea)
      void bombear()
    },
    [bombear, cambiarLote, cerrarSiTermino, loteDeFalla],
  )

  const cerrarFalla = useCallback(
    (clave: number) => {
      const lote = loteDeFalla(clave)
      if (!lote) return
      const tarea = fallidas.current.get(clave)
      if (tarea) {
        fallidas.current.delete(clave)
        accionesRef.current.descartarSubida(tarea.archivo)
      }
      cambiarLote(lote.clave, (actual) => ({
        ...actual,
        total: actual.total - 1,
        errores: actual.errores.filter((falla) => falla.clave !== clave),
      }))
      cerrarSiTermino(lote.clave)
    },
    [cambiarLote, cerrarSiTermino, loteDeFalla],
  )

  /** Saca de la fila y de los reintentos lo que cumpla la condición, y corta lo que esté subiendo. */
  const soltar = useCallback((cumple: (tarea: Tarea) => boolean) => {
    fila.current = fila.current.filter((tarea) => !cumple(tarea))
    if (enCurso.current && cumple(enCurso.current)) enCurso.current.control?.abort()
    for (const [clave, tarea] of fallidas.current) {
      if (!cumple(tarea)) continue
      fallidas.current.delete(clave)
      accionesRef.current.descartarSubida(tarea.archivo)
    }
  }, [])

  const cancelarLote = useCallback(
    (clave: number) => {
      soltar((tarea) => tarea.lote === clave)
      cambiar((lista) => lista.filter((lote) => lote.clave !== clave))
    },
    [cambiar, soltar],
  )

  const renombrarGrupo = useCallback(
    (grupo: string, nombre: string) => {
      for (const tarea of fila.current) if (tarea.grupo === grupo) tarea.grupo = nombre
      for (const tarea of fallidas.current.values()) if (tarea.grupo === grupo) tarea.grupo = nombre
      cambiar((lista) => lista.map((lote) => (lote.grupo === grupo ? { ...lote, grupo: nombre } : lote)))
    },
    [cambiar],
  )

  const cancelarGrupo = useCallback(
    (grupo: string | null) => {
      // Sin grupo hay dos cosas distintas: los sueltos, que son los que se quitaron, y los .zip que
      // van a armar su propia conversación, que siguen.
      const esDeAhi = (tarea: Tarea) => tarea.grupo === grupo && !(grupo === null && esZip(tarea.archivo.name))
      soltar(esDeAhi)
      cambiar((lista) => lista.filter((lote) => !(lote.grupo === grupo && lote.zip === null)))
    },
    [cambiar, soltar],
  )

  const vaciar = useCallback(() => {
    soltar(() => true)
    cambiar(() => [])
    setAvisos([])
  }, [cambiar, soltar])

  // Al pasar a otro paso, lo que quedó sin subir ya no tiene dónde ir: reintentarlo daría error.
  // Entre una espera y la vuelta al mismo paso el tipo no cambia, y la fila sigue como estaba.
  const tipoAnterior = useRef(pantalla.tipo)
  useEffect(() => {
    if (tipoAnterior.current === pantalla.tipo) return
    tipoAnterior.current = pantalla.tipo
    vaciar()
  }, [pantalla.tipo, vaciar])

  // Si la página se va, que no quede una subida corriendo sin nadie que la mire.
  useEffect(() => () => soltar(() => true), [soltar])

  useEffect(() => {
    if (!trabajando) return
    // Con la pantalla apagada el celular frena la subida: mientras dure, se le pide que no se apague.
    let candado: WakeLockSentinel | null = null
    let terminado = false
    async function mantenerDespierto() {
      if (!('wakeLock' in navigator)) return
      try {
        const nuevo = await navigator.wakeLock.request('screen')
        if (terminado) void nuevo.release()
        else candado = nuevo
      } catch {
        // Sin permiso o con poca batería no se puede: se sube igual.
      }
    }
    function alVolver() {
      // El candado se pierde al cambiar de app: al volver se pide de nuevo.
      if (document.visibilityState === 'visible') void mantenerDespierto()
    }
    function alCerrar(evento: BeforeUnloadEvent) {
      // Cerrar ahora corta lo que está subiendo: el navegador pregunta antes.
      evento.preventDefault()
    }
    void mantenerDespierto()
    document.addEventListener('visibilitychange', alVolver)
    window.addEventListener('beforeunload', alCerrar)
    return () => {
      terminado = true
      candado?.release().catch(() => {})
      document.removeEventListener('visibilitychange', alVolver)
      window.removeEventListener('beforeunload', alCerrar)
    }
  }, [trabajando])

  const activos = trabajando || lotes.some((lote) => pendientesDe(lote) > 0)
  const fallidos = lotes.reduce((suma, lote) => suma + lote.errores.length, 0)

  const subidas = useMemo<Subidas>(
    () => ({
      lotes,
      avisos,
      anuncio,
      activos,
      fallidos,
      encolar,
      reintentar,
      cerrarFalla,
      cancelarLote,
      avisar,
      cerrarAvisos,
      renombrarGrupo,
      cancelarGrupo,
      gruposEnUso,
    }),
    [
      lotes,
      avisos,
      anuncio,
      activos,
      fallidos,
      encolar,
      reintentar,
      cerrarFalla,
      cancelarLote,
      avisar,
      cerrarAvisos,
      renombrarGrupo,
      cancelarGrupo,
      gruposEnUso,
    ],
  )

  return <ContextoSubidas value={subidas}>{children}</ContextoSubidas>
}

/**
 * Lo que está subiendo, lo que falló y lo que conviene saber de lo que terminó. Lo que sube bien
 * desaparece de acá: ya está en la lista que devuelve el servidor (ListaDeMaterial).
 */
export function PanelDeSubidas({ id }: { id?: string }) {
  const { lotes, avisos, anuncio, activos, cerrarAvisos } = useSubidas()
  const vacio = lotes.length === 0 && avisos.length === 0

  return (
    <>
      {/* Siempre en la página: un lector de pantalla solo anuncia lo que cambia en una región que ya estaba. */}
      <p className="solo-lectores" role="status">
        {anuncio}
      </p>
      {!vacio && (
        <div className="subidas" id={id} tabIndex={-1}>
          {activos && (
            <p className="subidas-consejo solo-tactil">
              No bloquees el celular ni cambies de app hasta que termine de subir.
            </p>
          )}
          {lotes.length > 0 && (
            <ul className="subidas-lista">
              {lotes.map((lote) => (
                <FilaDeLote key={lote.clave} lote={lote} />
              ))}
            </ul>
          )}
          {avisos.length > 0 && (
            // Una sola caja para todos: subir tres conversaciones no deja tres carteles apilados.
            <div className="aviso subidas-aviso" role="status">
              <div className="subidas-aviso-textos">
                {avisos.map((aviso) => (
                  <p key={aviso.clave}>{aviso.texto}</p>
                ))}
              </div>
              <button type="button" className="boton boton-texto subidas-aviso-cerrar" onClick={cerrarAvisos}>
                Cerrar<span className="solo-lectores"> {avisos.length === 1 ? 'este aviso' : 'estos avisos'}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function FilaDeLote({ lote }: { lote: Lote }) {
  const { reintentar, cerrarFalla, cancelarLote } = useSubidas()
  const pendientes = pendientesDe(lote)
  const nombre = nombreDeLote(lote)
  const enviados = lote.bytesEnviados + lote.bytesDelActual
  const porcentaje =
    lote.bytesTotales > 0 ? Math.min(100, Math.max(0, Math.round((enviados / lote.bytesTotales) * 100))) : 0

  let texto: string
  if (pendientes === 0) texto = `No se pudo subir todo de ${nombre}`
  else if (!lote.subiendo) texto = `En fila: ${nombre} · ${cuantosArchivos(pendientes)}`
  else {
    // Un .zip entra entero y la conversación la arma el servidor; lo demás va «a» una conversación.
    const destino = lote.zip ? nombre : lote.grupo ? `a ${nombre}` : nombre
    const avance = lote.total > 1 ? `${lote.hechos} de ${lote.total} archivos · ` : ''
    // Con espacio duro: el «%» no queda solo en el renglón de abajo.
    texto = `Subiendo ${destino}: ${avance}${porcentaje}\u00a0%`
  }

  return (
    <li className="subida-lote">
      <div className="subida-lote-fila">
        <p className="subida-lote-texto">{texto}</p>
        {pendientes > 0 && (
          <button
            type="button"
            className="boton boton-texto subida-lote-accion"
            onClick={() => cancelarLote(lote.clave)}
            aria-label={`Cancelar la subida de ${nombre}`}
          >
            Cancelar
          </button>
        )}
      </div>
      {pendientes > 0 && lote.subiendo && (
        <div
          className="progreso-barra"
          role="progressbar"
          aria-label={`Subida de ${nombre}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={porcentaje}
          aria-valuetext={texto}
        >
          <div className="progreso-relleno" style={{ width: `${porcentaje}%` }} />
        </div>
      )}
      {lote.errores.length > 0 && (
        <ul className="lista-archivos">
          {lote.errores.map((falla) => (
            <li key={falla.clave} className="archivo archivo-con-error archivo-con-acciones">
              <span className="archivo-marca-error" aria-hidden="true">
                !
              </span>
              <div className="archivo-cuerpo">
                <span className="archivo-nombre">{falla.nombre}</span>
                <span className="archivo-error" role="alert">
                  {falla.error}
                </span>
              </div>
              <div className="archivo-acciones">
                {falla.reintentable && (
                  <button
                    type="button"
                    className="boton boton-texto archivo-accion"
                    onClick={() => reintentar(falla.clave)}
                    aria-label={`Reintentar ${falla.nombre}`}
                  >
                    Reintentar
                  </button>
                )}
                <button
                  type="button"
                  className="boton boton-texto archivo-accion"
                  onClick={() => cerrarFalla(falla.clave)}
                  aria-label={`Cerrar el aviso de ${falla.nombre}`}
                >
                  Cerrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

interface PropsZona {
  /** En el pedido de chat se espera una sola conversación: no se arman otras ni hay «otros archivos». */
  variante: 'material' | 'pedido_chat'
  /** El formulario de «Armar una conversación», que vive en la pantalla. Sin esto no se ofrece. */
  armar?: {
    idBoton: string
    idFormulario: string
    abierto: boolean
    /** Con archivos: los sueltos que parecen de un chat y falta saber de cuál. Vacío: se eligen después. */
    abrir: (archivos: File[]) => void
  }
}

/**
 * Por dónde entran los archivos: el .zip que exporta WhatsApp, una carpeta (en la compu), una
 * conversación armada a mano o archivos sueltos. En la compu también se pueden arrastrar.
 */
export function ZonaDeSubida({ variante, armar }: PropsZona) {
  const { ocupado } = useCuestionario()
  const { encolar, avisar, activos } = useSubidas()
  const selectorZip = useRef<HTMLInputElement>(null)
  const selectorCarpeta = useRef<HTMLInputElement>(null)
  const selectorSueltos = useRef<HTMLInputElement>(null)
  const [arrastrando, setArrastrando] = useState(false)
  const [conCarpeta, setConCarpeta] = useState(false)
  const [leyendo, setLeyendo] = useState(false)
  const idAyuda = useId()

  // Con subidas propias en curso se pueden sumar más; lo que bloquea es otra cosa en camino.
  const bloqueado = (ocupado && !activos) || leyendo

  useEffect(() => {
    // Después de montar y no al pintar: en el servidor no se sabe qué dispositivo es, y el primer
    // HTML tiene que coincidir. El iPad dice ser una Mac y tiene el atributo, pero no deja elegir
    // carpetas; en los celulares tampoco anda.
    const esIPad = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1
    setConCarpeta(
      'webkitdirectory' in HTMLInputElement.prototype &&
        window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
        !esIPad,
    )
  }, [])

  useEffect(() => {
    // React no conoce el atributo: se pone a mano cuando aparece el selector.
    if (conCarpeta) selectorCarpeta.current?.setAttribute('webkitdirectory', '')
  }, [conCarpeta])

  useEffect(() => {
    // Si el archivo cae fuera de la zona, el navegador lo abre y el cliente sale del cuestionario.
    function evitarQueSeAbra(evento: DragEvent) {
      if (evento.dataTransfer?.types.includes('Files')) evento.preventDefault()
    }
    window.addEventListener('dragover', evitarQueSeAbra)
    window.addEventListener('drop', evitarQueSeAbra)
    return () => {
      window.removeEventListener('dragover', evitarQueSeAbra)
      window.removeEventListener('drop', evitarQueSeAbra)
    }
  }, [])

  function repartir(archivos: ArchivoParaSubir[]) {
    // Fotos y audios sueltos con nombre de WhatsApp casi seguro son de un chat. Como «otros
    // archivos» quedarían todos en la misma pila, mezclados con los de otro chat: mejor preguntar.
    const sueltos = archivos.filter(({ archivo, grupo }) => grupo === null && !esZip(archivo.name))
    if (armar && sueltos.some(({ archivo, esChat }) => pareceDeWhatsApp(archivo.name, esChat))) {
      encolar(archivos.filter((item) => !sueltos.includes(item)))
      armar.abrir(sueltos.map(({ archivo }) => archivo))
      return
    }
    encolar(archivos)
  }

  async function recibir(elegidos: ArchivoConRuta[] | Promise<ArchivoConRuta[]>) {
    if (bloqueado) return
    setLeyendo(true)
    try {
      const lista = await elegidos
      if (lista.length > LIMITE_ARCHIVOS) {
        avisar(MENSAJE_DEMASIADOS)
        return
      }
      const archivos = await conGrupos(lista, null)
      if (archivos.length === 0) avisar(MENSAJE_SIN_ARCHIVOS)
      else repartir(archivos)
    } catch {
      avisar(MENSAJE_NO_SE_LEYO)
    } finally {
      setLeyendo(false)
    }
  }

  function alElegir(selector: HTMLInputElement) {
    const elegidos = archivosDelSelector(selector.files)
    // Sin esto, volver a elegir el mismo archivo (después de un error) no dispara el cambio.
    selector.value = ''
    if (elegidos.length > 0) void recibir(elegidos)
  }

  function tieneArchivos(evento: ArrastreReact<HTMLElement>) {
    return evento.dataTransfer.types.includes('Files')
  }

  function alEntrar(evento: ArrastreReact<HTMLDivElement>) {
    if (!tieneArchivos(evento)) return
    evento.preventDefault()
    setArrastrando(true)
  }

  function alPasar(evento: ArrastreReact<HTMLDivElement>) {
    if (!tieneArchivos(evento)) return
    evento.preventDefault()
    evento.dataTransfer.dropEffect = bloqueado ? 'none' : 'copy'
  }

  function alSalir(evento: ArrastreReact<HTMLDivElement>) {
    // dragleave también salta al pasar por encima de un hijo: solo cuenta si salió de la zona.
    if (!evento.currentTarget.contains(evento.relatedTarget as Node | null)) setArrastrando(false)
  }

  function alSoltar(evento: ArrastreReact<HTMLDivElement>) {
    evento.preventDefault()
    setArrastrando(false)
    if (bloqueado) return
    // Se llama acá mismo y no adentro de `recibir`: las carpetas hay que pedirlas antes de que
    // termine el evento.
    void recibir(archivosSoltados(evento.dataTransfer))
  }

  const clasesZona = ['subida-zona', 'subida-zona-arrastrable', arrastrando && 'subida-zona-activa']
    .filter(Boolean)
    .join(' ')
  const textoSueltos =
    variante === 'material' ? 'Otros archivos (lista de precios, catálogo)' : 'Subir capturas del chat'

  return (
    <div className="subida">
      <div
        className={clasesZona}
        onDragEnter={alEntrar}
        onDragOver={alPasar}
        onDragLeave={alSalir}
        onDrop={alSoltar}
      >
        <p className="subida-arrastrar" aria-hidden="true">
          Arrastrá acá las carpetas o los .zip, uno por conversación.
        </p>
        <div className="subida-botones">
          <Boton
            variante="secundario"
            onClick={() => selectorZip.current?.click()}
            disabled={bloqueado}
            aria-describedby={idAyuda}
          >
            <IconoSubir />
            Subir el .zip de WhatsApp
          </Boton>
          {conCarpeta && (
            <Boton variante="secundario" onClick={() => selectorCarpeta.current?.click()} disabled={bloqueado}>
              <IconoCarpeta />
              Elegir carpeta
            </Boton>
          )}
          {armar && (
            <Boton
              id={armar.idBoton}
              variante="secundario"
              onClick={() => armar.abrir([])}
              disabled={bloqueado}
              aria-expanded={armar.abierto}
              aria-controls={armar.abierto ? armar.idFormulario : undefined}
            >
              <IconoChat />
              Armar una conversación con archivos sueltos
            </Boton>
          )}
          <Boton variante="secundario" onClick={() => selectorSueltos.current?.click()} disabled={bloqueado}>
            <IconoArchivo />
            {textoSueltos}
          </Boton>
        </div>
        {leyendo && (
          <p className="espera-en-linea" role="status">
            <span className="girando" aria-hidden="true" />
            Leyendo lo que elegiste…
          </p>
        )}
        <div className="subida-ayuda" id={idAyuda}>
          <p>
            No abras el .zip: elegilo tal cual.{' '}
            {variante === 'material'
              ? 'Entran audios, videos, fotos, PDF, Word y Excel, hasta 200 MB cada uno.'
              : 'También sirven la carpeta del chat o capturas.'}
          </p>
          <p className="solo-tactil">No bloquees el celular ni cambies de app hasta que termine de subir.</p>
        </div>
        {/* Sin `accept` en los dos últimos: así el celular ofrece fotos, videos y archivos. El del
            .zip sí lo lleva, para que el iPhone abra directo «Archivos», que es donde quedó guardado. */}
        <input
          ref={selectorZip}
          className="solo-lectores"
          type="file"
          multiple
          accept=".zip,application/zip,application/x-zip-compressed"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(evento) => alElegir(evento.target)}
        />
        {conCarpeta && (
          <input
            ref={selectorCarpeta}
            className="solo-lectores"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(evento) => alElegir(evento.target)}
          />
        )}
        <input
          ref={selectorSueltos}
          className="solo-lectores"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(evento) => alElegir(evento.target)}
        />
      </div>

      <details className="ayuda-plegable">
        <summary>¿Cómo saco el chat de WhatsApp?</summary>
        <dl className="ayuda-pasos">
          <div>
            <dt>En iPhone</dt>
            <dd>
              Abrí el chat, tocá el nombre de arriba, «Exportar chat» y «Adjuntar archivos». Elegí
              «Guardar en Archivos». Después, acá, tocá «Subir el .zip de WhatsApp» y elegilo sin abrirlo.
            </dd>
          </div>
          <div>
            <dt>En Android</dt>
            <dd>
              Abrí el chat, tocá los tres puntos, «Más», «Exportar chat» e «Incluir archivos». Si te
              queda un .zip, subilo. Si te quedan archivos sueltos,{' '}
              {armar
                ? 'tocá «Armar una conversación con archivos sueltos» y elegilos todos juntos.'
                : `tocá «${textoSueltos}» y elegilos todos juntos.`}
            </dd>
          </div>
          <div>
            <dt>En la compu</dt>
            <dd>
              Si ya tenés una carpeta por conversación, tocá «Elegir carpeta» y elegí la que las tiene
              a todas: cada una queda separada. También podés arrastrarlas.
            </dd>
          </div>
        </dl>
      </details>
    </div>
  )
}
