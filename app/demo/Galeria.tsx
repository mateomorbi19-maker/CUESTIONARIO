'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { EstadoPublico } from '@/lib/estado-publico'
import type { ArchivoPublico, Entrada, TipoMaterial } from '@/lib/motor/tipos'
import type { Resultado } from '../c/[token]/componentes/Contexto'
import { Cargando, LinkInvalido, SinConexion } from '../c/[token]/componentes/Estados'
import { Marco } from '../c/[token]/componentes/Marco'
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
          Simular que el servidor rechaza envíos y subidas
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

function VarianteDemo({ variante, rechazar, compacto = false }: PropsVariante) {
  const [estado, setEstado] = useState<EstadoPublico | null>(variante.estado ?? null)
  const [error, setError] = useState<string | null>(variante.error ?? null)
  const [trabajos, setTrabajos] = useState(0)
  const [marcaGuardado, setMarcaGuardado] = useState(0)
  const [ultimaEntrada, setUltimaEntrada] = useState<Entrada | null>(null)
  const [reintentando, setReintentando] = useState(false)
  const [registro, setRegistro] = useState<string[]>([])

  const anotar = useCallback((linea: string) => {
    setRegistro((anteriores) => [linea, ...anteriores].slice(0, 5))
  }, [])

  // Como la API: primero acepta (202) y después procesa un rato en segundo plano.
  const procesar = useCallback(
    async (mensaje: string, ms: number, aplicar: (e: EstadoPublico) => EstadoPublico = (e) => e) => {
      setEstado((e) => e && { ...e, procesando: true, mensajeEspera: mensaje, error: null, entradaPendiente: null })
      await esperar(ms)
      setEstado((e) => e && aplicar({ ...e, procesando: false, mensajeEspera: null, version: e.version + 1 }))
    },
    [],
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
    async (archivo: File): Promise<Resultado> => {
      anotar(`POST /archivos ${archivo.name}`)
      setTrabajos((n) => n + 1)
      await esperar(900)
      setTrabajos((n) => n - 1)
      if (rechazar) {
        return {
          ok: false,
          error: `Ejemplo de respuesta 400: «${archivo.name}» no se pudo leer. Probá exportarlo de nuevo.`,
        }
      }
      const nuevo: ArchivoPublico = {
        id: `archivo-${Date.now()}-${Math.round(Math.random() * 1000)}`,
        nombre: archivo.name,
        tipo: tipoDe(archivo),
      }
      setEstado((e) => e && conArchivos(e, (archivos) => [...archivos, nuevo]))
      setMarcaGuardado((n) => n + 1)
      return { ok: true }
    },
    [anotar, rechazar],
  )

  const quitarArchivo = useCallback(
    async (id: string): Promise<Resultado> => {
      anotar(`DELETE /archivos/${id}`)
      setTrabajos((n) => n + 1)
      await esperar(500)
      setTrabajos((n) => n - 1)
      if (rechazar) return { ok: false, error: 'Ejemplo de error: no se pudo quitar. Probá de nuevo.' }
      setEstado((e) => e && conArchivos(e, (archivos) => archivos.filter((a) => a.id !== id)))
      setMarcaGuardado((n) => n + 1)
      return { ok: true }
    },
    [anotar, rechazar],
  )

  const reintentar = useCallback(async () => {
    anotar(`POST /entrada ${JSON.stringify(estado?.entradaPendiente ?? null)} (reintento)`)
    setReintentando(true)
    await esperar(600)
    setReintentando(false)
    setMarcaGuardado((n) => n + 1)
    void procesar('Probando de nuevo…', 2400)
  }, [anotar, estado, procesar])

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
      quitarArchivo,
      ocupado: trabajos > 0 || procesando,
      error,
    }),
    [enviar, subirArchivo, quitarArchivo, trabajos, procesando, error],
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
  return estado
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

function tipoDe(archivo: File): TipoMaterial {
  if (archivo.type.startsWith('image/')) return 'imagen'
  if (archivo.type === 'application/pdf' || archivo.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  return 'texto'
}
