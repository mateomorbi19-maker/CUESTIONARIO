'use client'

import Link from 'next/link'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DestinoSubida, OpcionesSubida } from '@/lib/cliente-api'
import type { EstadoPublico } from '@/lib/estado-publico'
import { grupoDeZip, grupoLibre, sanearGrupo, sanearNombre } from '@/lib/grupos'
import { UMBRAL_MULTIPART } from '@/lib/limites'
import { PROBLEMA_FORMATO } from '@/lib/motor/textos'
import type { ArchivoPublico, Entrada, TipoMaterial } from '@/lib/motor/tipos'
import type { Resultado, ResultadoUi } from '../c/[token]/componentes/Contexto'
import { Cargando, LinkInvalido, SinConexion } from '../c/[token]/componentes/Estados'
import { Marco } from '../c/[token]/componentes/Marco'
import { ProveedorDeSubidas } from '../c/[token]/componentes/SubidaDeArchivos'
import { VistaCuestionario } from '../c/[token]/componentes/VistaCuestionario'
import { VARIANTES, type Variante } from './variantes'

function esperar(ms: number) {
  return new Promise<void>((listo) => window.setTimeout(listo, ms))
}

/**
 * Las pantallas del cuestionario con datos inventados, para revisarlas sin servidor. Los botones
 * van contra manejadores de ejemplo que imitan a la API: demoran, guardan en memoria y, con el
 * interruptor, rechazan como lo haría el servidor.
 */
export default function Galeria({ sola }: { sola: string | null }) {
  const [rechazar, setRechazar] = useState(false)

  if (sola !== null) {
    const variante = VARIANTES.find((v) => v.id === sola)
    if (!variante) {
      return (
        <div className="demo">
          <div className="demo-cabecera">
            <p>No hay ninguna variante «{sola}».</p>
            <Link href="/demo">Volver a la galería</Link>
          </div>
        </div>
      )
    }
    return (
      <>
        <VarianteDemo variante={variante} rechazar={false} />
        <p className="demo-volver">
          <Link href={`/demo#${variante.id}`}>Volver a la galería</Link>
        </p>
      </>
    )
  }

  return (
    <div className="demo">
      <header className="demo-cabecera">
        <h1>Galería de pantallas</h1>
        <p>
          Solo existe en desarrollo. Datos inventados y sin servidor: los botones responden con
          manejadores de ejemplo, y abajo de cada pantalla se anota lo que se habría mandado.
        </p>
        <label className="demo-interruptor">
          <input
            type="checkbox"
            checked={rechazar}
            onChange={(evento) => setRechazar(evento.target.checked)}
          />
          Simular que el servidor rechaza envíos y que las subidas se cortan
        </label>
        <p>
          Inicio: <Link href="/?c=demo">con código</Link> · <Link href="/">sin código</Link>
        </p>
        <nav aria-label="Variantes">
          <ol className="demo-indice">
            {VARIANTES.map((variante) => (
              <li key={variante.id}>
                <a href={`#${variante.id}`}>{variante.titulo}</a>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      {VARIANTES.map((variante) => (
        <section
          key={variante.id}
          id={variante.id}
          className="demo-variante"
          aria-labelledby={`${variante.id}-titulo`}
        >
          <div className="demo-rotulo">
            <h2 id={`${variante.id}-titulo`}>{variante.titulo}</h2>
            <Link href={`/demo?v=${variante.id}`}>Ver sola</Link>
            {variante.nota && <p className="demo-nota">{variante.nota}</p>}
          </div>
          <VarianteDemo variante={variante} rechazar={rechazar} compacto />
        </section>
      ))}
    </div>
  )
}

interface PropsVariante {
  variante: Variante
  rechazar: boolean
  compacto?: boolean
}

const SUBIDA_CORTADA = 'La subida se cortó. Revisá la conexión y tocá «Reintentar»: sigue desde donde quedó.'

function VarianteDemo({ variante, rechazar, compacto = false }: PropsVariante) {
  const [estado, setEstado] = useState<EstadoPublico | null>(variante.estado ?? null)
  const [error, setError] = useState<string | null>(variante.error ?? null)
  const [trabajos, setTrabajos] = useState(0)
  const [marcaGuardado, setMarcaGuardado] = useState(0)
  const [ultimaEntrada, setUltimaEntrada] = useState<Entrada | null>(null)
  const [reintentando, setReintentando] = useState(false)
  const [registro, setRegistro] = useState<string[]>([])
  // La verdad de los manejadores, que contestan según lo que ya hay (repetidos, nombres usados)
  // sin esperar al próximo render.
  const estadoRef = useRef(estado)

  const cambiar = useCallback((cambio: (e: EstadoPublico) => EstadoPublico) => {
    if (!estadoRef.current) return
    estadoRef.current = cambio(estadoRef.current)
    setEstado(estadoRef.current)
  }, [])

  const anotar = useCallback((linea: string) => {
    setRegistro((anteriores) => [linea, ...anteriores].slice(0, 5))
  }, [])

  // Como la API: primero acepta (202) y después procesa un rato en segundo plano.
  const procesar = useCallback(
    async (mensaje: string, ms: number, aplicar: (e: EstadoPublico) => EstadoPublico = (e) => e) => {
      cambiar((e) => ({ ...e, procesando: true, mensajeEspera: mensaje, error: null, entradaPendiente: null }))
      await esperar(ms)
      cambiar((e) => aplicar({ ...e, procesando: false, mensajeEspera: null, version: e.version + 1 }))
    },
    [cambiar],
  )

  const enviar = useCallback(
    async (entrada: Entrada) => {
      anotar(`POST /entrada ${JSON.stringify(entrada)}`)
      setError(null)
      setUltimaEntrada(entrada)
      setTrabajos((n) => n + 1)
      await esperar(600)
      setTrabajos((n) => n - 1)
      if (rechazar) {
        setError('Ejemplo de respuesta 400: la respuesta llegó vacía. Escribí algo antes de seguir.')
        return false
      }
      setMarcaGuardado((n) => n + 1)
      const cambioDeMaterial = entrada.tipo === 'texto_material' || entrada.tipo === 'quitar_texto'
      void procesar(
        cambioDeMaterial ? 'Guardando el texto…' : 'Leyendo lo que mandaste…',
        cambioDeMaterial ? 1200 : 2600,
        (e) => aplicarEntrada(e, entrada),
      )
      return true
    },
    [anotar, procesar, rechazar],
  )

  const subirArchivo = useCallback(
    async (archivo: File, destino: DestinoSubida, opciones?: OpcionesSubida): Promise<ResultadoUi> => {
      const ruta = archivo.size > UMBRAL_MULTIPART ? 'PUT /subidas/:id (por partes)' : 'POST /archivos'
      anotar(`${ruta} ${archivo.name} → ${destino.grupo ?? 'sin conversación'}`)
      setTrabajos((n) => n + 1)
      try {
        // Como la subida por partes: avanza de a poco, se puede cancelar y se puede cortar.
        for (let parte = 1; parte <= 5; parte++) {
          await esperar(220)
          if (opciones?.senal?.aborted) return { ok: false, error: 'Se canceló antes de terminar.' }
          if (rechazar && parte === 3) return { ok: false, error: SUBIDA_CORTADA }
          opciones?.alProgresar?.(Math.round((archivo.size * parte) / 5), archivo.size)
        }
        const actuales = archivosDe(estadoRef.current)
        const nuevos = archivosDeEjemplo(archivo, destino, actuales)
        // Como el servidor: un chat suelto no entra en una conversación que ya tiene otro distinto.
        const [unico] = nuevos
        const chocaConOtroChat =
          nuevos.length === 1 &&
          unico.esChat &&
          unico.grupo !== null &&
          actuales.some((a) => a.grupo === unico.grupo && a.esChat && a.bytes !== unico.bytes)
        if (chocaConOtroChat) {
          return {
            ok: false,
            error: 'Ejemplo de respuesta 409: esa conversación ya tiene otro chat.',
            motivo: 'grupo_con_otro_chat',
          }
        }
        // Como el servidor: lo que ya está en esa conversación con el mismo nombre y peso no se repite.
        const agregados = nuevos.filter(
          (nuevo) =>
            !actuales.some(
              (a) => a.grupo === nuevo.grupo && a.nombre === nuevo.nombre && a.bytes === nuevo.bytes,
            ),
        )
        cambiar((e) => conArchivos(e, (archivos) => [...archivos, ...agregados]))
        setMarcaGuardado((n) => n + 1)
        return {
          ok: true,
          agregados: agregados.length,
          repetidos: nuevos.length - agregados.length,
          omitidos: [],
          grupos: [...new Set(nuevos.map((nuevo) => nuevo.grupo))],
        }
      } finally {
        setTrabajos((n) => n - 1)
      }
    },
    [anotar, cambiar, rechazar],
  )

  const descartarSubida = useCallback(
    (archivo: File) => anotar(`DELETE /subidas/:id (${archivo.name})`),
    [anotar],
  )

  /** Quitar y renombrar: demoran un poco y, con el interruptor, fallan. */
  const cambiarMaterial = useCallback(
    async (pedido: string, cambio: (archivos: ArchivoPublico[]) => ArchivoPublico[] | string): Promise<Resultado> => {
      anotar(pedido)
      setTrabajos((n) => n + 1)
      await esperar(500)
      setTrabajos((n) => n - 1)
      if (rechazar) return { ok: false, error: 'Ejemplo de error: no se pudo guardar el cambio. Probá de nuevo.' }
      const resultado = cambio(archivosDe(estadoRef.current))
      if (typeof resultado === 'string') return { ok: false, error: resultado }
      cambiar((e) => conArchivos(e, () => resultado))
      setMarcaGuardado((n) => n + 1)
      return { ok: true }
    },
    [anotar, cambiar, rechazar],
  )

  const quitarArchivo = useCallback(
    (id: string) => cambiarMaterial(`DELETE /archivos/${id}`, (archivos) => archivos.filter((a) => a.id !== id)),
    [cambiarMaterial],
  )

  const quitarConversacion = useCallback(
    (grupo: string | null) =>
      cambiarMaterial(`DELETE /conversaciones ${JSON.stringify({ grupo })}`, (archivos) =>
        archivos.filter((a) => a.grupo !== grupo),
      ),
    [cambiarMaterial],
  )

  const renombrarConversacion = useCallback(
    (grupo: string, nombre: string) =>
      cambiarMaterial(`PATCH /conversaciones ${JSON.stringify({ grupo, nombre })}`, (archivos) => {
        const nuevo = sanearGrupo(nombre)
        if (!nuevo) return 'Ejemplo de respuesta 400: escribí un nombre para la conversación.'
        if (archivos.some((a) => a.grupo === nuevo)) {
          return 'Ejemplo de respuesta 400: ya hay otra conversación con ese nombre. Ponele uno distinto.'
        }
        return archivos.map((a) => (a.grupo === grupo ? { ...a, grupo: nuevo } : a))
      }),
    [cambiarMaterial],
  )

  const recargar = useCallback(async () => {
    anotar('GET /api/cuestionarios/demo')
    await esperar(400)
    // Como si ya hubieran terminado de escucharse: lo que estaba en proceso queda listo.
    cambiar((e) =>
      conArchivos(e, (archivos) =>
        archivos.map((a) => (a.estado === 'en_proceso' ? { ...a, estado: 'listo', duracion: 47 } : a)),
      ),
    )
  }, [anotar, cambiar])

  const reintentar = useCallback(async () => {
    anotar(`POST /entrada ${JSON.stringify(estadoRef.current?.entradaPendiente ?? null)} (reintento)`)
    setReintentando(true)
    await esperar(600)
    setReintentando(false)
    setMarcaGuardado((n) => n + 1)
    void procesar('Probando de nuevo…', 2400)
  }, [anotar, procesar])

  const reintentarCarga = useCallback(async () => {
    anotar('GET /api/cuestionarios/demo')
    setReintentando(true)
    await esperar(900)
    setReintentando(false)
  }, [anotar])

  const procesando = estado?.procesando ?? false
  const acciones = useMemo(
    () => ({
      token: 'demo',
      enviar,
      subirArchivo,
      descartarSubida,
      quitarArchivo,
      quitarConversacion,
      renombrarConversacion,
      recargar,
      ocupado: trabajos > 0 || procesando,
      error,
    }),
    [
      enviar,
      subirArchivo,
      descartarSubida,
      quitarArchivo,
      quitarConversacion,
      renombrarConversacion,
      recargar,
      trabajos,
      procesando,
      error,
    ],
  )

  let contenido: ReactNode = null
  if (variante.tipo === 'cargando') {
    contenido = (
      <Marco progreso={null} compacto={compacto}>
        <Cargando />
      </Marco>
    )
  } else if (variante.tipo === 'invalido') {
    contenido = (
      <Marco progreso={null} compacto={compacto}>
        <LinkInvalido />
      </Marco>
    )
  } else if (variante.tipo === 'sin_conexion') {
    contenido = (
      <Marco progreso={null} compacto={compacto}>
        <SinConexion
          mensaje="No hay conexión. Revisá que tengas internet y probá de nuevo."
          onReintentar={reintentarCarga}
          reintentando={reintentando}
        />
      </Marco>
    )
  } else if (estado) {
    contenido = (
      <ProveedorDeSubidas acciones={acciones} pantalla={estado.pantalla} lotesIniciales={variante.subidas}>
        <VistaCuestionario
          estado={estado}
          acciones={acciones}
          guardando={trabajos > 0}
          aviso={variante.aviso ?? null}
          marcaGuardado={marcaGuardado}
          ultimaEntrada={ultimaEntrada}
          onReintentar={reintentar}
          reintentando={reintentando}
          compacto={compacto}
          modoInicial={variante.modoInicial}
        />
      </ProveedorDeSubidas>
    )
  }

  return (
    <>
      {contenido}
      {compacto && registro.length > 0 && <pre className="demo-registro">{registro.join('\n')}</pre>}
    </>
  )
}

function aplicarEntrada(estado: EstadoPublico, entrada: Entrada): EstadoPublico {
  const { pantalla } = estado
  if (pantalla.tipo !== 'material') return estado
  if (entrada.tipo === 'texto_material') {
    const extracto = entrada.texto.replace(/\s+/g, ' ').slice(0, 90)
    const textos = [...pantalla.textos, { id: `texto-${Date.now()}`, extracto }]
    return { ...estado, pantalla: { ...pantalla, textos } }
  }
  if (entrada.tipo === 'quitar_texto') {
    const textos = pantalla.textos.filter((texto) => texto.id !== entrada.id)
    return { ...estado, pantalla: { ...pantalla, textos } }
  }
  // De verdad pasaría a la entrevista. Acá se queda en la misma pantalla, ya sin el aviso.
  if (entrada.tipo === 'terminar_material') return { ...estado, pantalla: { ...pantalla, avisoLectura: null } }
  return estado
}

function archivosDe(estado: EstadoPublico | null): ArchivoPublico[] {
  const pantalla = estado?.pantalla
  return pantalla?.tipo === 'material' || pantalla?.tipo === 'pedido_chat' ? pantalla.archivos : []
}

function conArchivos(
  estado: EstadoPublico,
  cambiar: (archivos: ArchivoPublico[]) => ArchivoPublico[],
): EstadoPublico {
  const { pantalla } = estado
  if (pantalla.tipo === 'material') {
    return { ...estado, pantalla: { ...pantalla, archivos: cambiar(pantalla.archivos) } }
  }
  if (pantalla.tipo === 'pedido_chat') {
    return { ...estado, pantalla: { ...pantalla, archivos: cambiar(pantalla.archivos) } }
  }
  return estado
}

let archivosCreados = 0

function archivoDeEjemplo(
  nombre: string,
  tipo: TipoMaterial,
  grupo: string | null,
  bytes: number,
  esChat = false,
): ArchivoPublico {
  const sinLeer = tipo === 'imagen' || tipo === 'pdf' || tipo === 'audio' || tipo === 'video'
  return {
    id: `archivo-${++archivosCreados}`,
    nombre: sanearNombre(nombre),
    tipo,
    estado: tipo === 'otro' ? 'con_problema' : sinLeer ? 'sin_leer' : 'listo',
    problema: tipo === 'otro' ? PROBLEMA_FORMATO : null,
    grupo,
    esChat,
    duracion: null,
    bytes,
  }
}

/** Lo que quedaría guardado: el archivo, o lo de adentro si es un .zip (tres archivos inventados). */
function archivosDeEjemplo(archivo: File, destino: DestinoSubida, actuales: ArchivoPublico[]): ArchivoPublico[] {
  if (!/\.zip$/i.test(archivo.name)) {
    const esChat = /chat.*\.txt$/i.test(archivo.name)
    return [archivoDeEjemplo(archivo.name, tipoDe(archivo), destino.grupo, archivo.size, esChat)]
  }
  let grupo = destino.grupoElegido ? destino.grupo : (destino.grupo ?? grupoDeZip(archivo.name))
  const chat = Math.max(1, Math.round(archivo.size / 40))
  // Como el servidor: si esa conversación ya tiene otro chat, el .zip va a «Nombre (2)».
  const conOtroChat = actuales.some((a) => a.grupo === grupo && a.esChat && a.bytes !== chat)
  if (grupo && conOtroChat) grupo = grupoLibre(grupo, actuales.map((a) => a.grupo))
  return [
    archivoDeEjemplo('_chat.txt', 'texto', grupo, chat, true),
    archivoDeEjemplo('00000012-AUDIO-2026-09-02-18-41-12.opus', 'audio', grupo, chat * 9),
    archivoDeEjemplo('00000015-PHOTO-2026-09-02-18-43-02.jpg', 'imagen', grupo, chat * 30),
  ]
}

const EXTENSIONES: Partial<Record<TipoMaterial, RegExp>> = {
  audio: /\.(opus|ogg|oga|m4a|mp3|wav|aac|flac|amr)$/i,
  video: /\.(mp4|mov|webm|3gp|avi|mkv)$/i,
  imagen: /\.(jpe?g|png|webp|gif|heic|heif)$/i,
  pdf: /\.pdf$/i,
  texto: /\.(txt|csv|md|docx|xlsx)$/i,
}

function tipoDe(archivo: File): TipoMaterial {
  // Por extensión: el navegador no siempre sabe el tipo de un .opus o de un .heic.
  for (const [tipo, extension] of Object.entries(EXTENSIONES)) {
    if (extension.test(archivo.name)) return tipo as TipoMaterial
  }
  if (archivo.type.startsWith('image/')) return 'imagen'
  if (archivo.type.startsWith('audio/')) return 'audio'
  if (archivo.type.startsWith('video/')) return 'video'
  return 'otro'
}
