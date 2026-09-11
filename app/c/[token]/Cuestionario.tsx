'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ErrorApi,
  borrarBorradores,
  guardarToken,
  leerEstado,
  mandarEntrada,
  olvidarToken,
  quitarArchivo as quitarArchivoApi,
  subirArchivos,
} from '@/lib/cliente-api'
import type { EstadoPublico } from '@/lib/estado-publico'
import type { Entrada } from '@/lib/motor/tipos'
import type { AccionesCuestionario, Resultado } from './componentes/Contexto'
import { Cargando, LinkInvalido, SinConexion } from './componentes/Estados'
import { Marco } from './componentes/Marco'
import { VistaCuestionario } from './componentes/VistaCuestionario'

/** Cada cuánto se pregunta si terminó de procesarse lo último (docs/API.md). */
const INTERVALO_ESPERA_MS = 2000
const AVISO_OTRA_PESTANA = 'Se actualizó desde otra pestaña.'

type Carga =
  | { tipo: 'cargando' }
  | { tipo: 'invalido' }
  | { tipo: 'sin_conexion'; mensaje: string }
  | { tipo: 'listo'; estado: EstadoPublico }

type Lectura = 'aplicada' | 'descartada' | 'fallida'

/**
 * El cuestionario de un cliente. Acá vive todo lo que habla con la API: pedir el estado, mandar
 * entradas, esperar mientras se procesa, subir y quitar archivos, y qué hacer con cada error. Lo
 * que se ve lo decide `VistaCuestionario`, que también usa la galería de /demo.
 */
export default function Cuestionario({ token }: { token: string }) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' })
  const [trabajos, setTrabajos] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [marcaGuardado, setMarcaGuardado] = useState(0)
  const [sinConexion, setSinConexion] = useState(false)
  const [ultimaEntrada, setUltimaEntrada] = useState<Entrada | null>(null)
  const [reintentando, setReintentando] = useState(false)
  const [reintentosEspera, setReintentosEspera] = useState(0)

  // Lo último que llegó, para leerlo desde funciones que no se rearman en cada render.
  const estadoRef = useRef<EstadoPublico | null>(null)
  // Lo que está en camino. Va en una ref además del estado: dos toques seguidos llegan antes de
  // que React vuelva a pintar, y el segundo mandaría la misma entrada con la versión vieja.
  const trabajosRef = useRef(0)
  // Sube con cada envío: una lectura del estado que salió antes llega vieja y no se aplica.
  const enviosRef = useRef(0)

  const estado = carga.tipo === 'listo' ? carga.estado : null
  const procesando = estado?.procesando ?? false
  const terminado = estado?.pantalla.tipo === 'gracias'

  const aplicarEstado = useCallback((nuevo: EstadoPublico) => {
    estadoRef.current = nuevo
    setCarga({ tipo: 'listo', estado: nuevo })
  }, [])

  const empezarTrabajo = useCallback(() => {
    trabajosRef.current += 1
    enviosRef.current += 1
    setTrabajos(trabajosRef.current)
  }, [])

  const terminarTrabajo = useCallback(() => {
    trabajosRef.current -= 1
    setTrabajos(trabajosRef.current)
  }, [])

  const marcarLinkInvalido = useCallback(() => {
    olvidarToken(token)
    setCarga({ tipo: 'invalido' })
  }, [token])

  const cargar = useCallback(async (): Promise<Lectura> => {
    const enviosAlSalir = enviosRef.current
    try {
      const nuevo = await leerEstado(token)
      setSinConexion(false)
      // Si mientras tanto salió un envío, esta respuesta es de antes: manda la del envío.
      if (enviosRef.current !== enviosAlSalir) return 'descartada'
      aplicarEstado(nuevo)
      return 'aplicada'
    } catch (err) {
      if (err instanceof ErrorApi && err.estado === 404) marcarLinkInvalido()
      else if (!estadoRef.current) setCarga({ tipo: 'sin_conexion', mensaje: mensajeDe(err) })
      return 'fallida'
    }
  }, [token, aplicarEstado, marcarLinkInvalido])

  useEffect(() => {
    guardarToken(token)
    void cargar()
  }, [token, cargar])

  // Mientras se procesa se vuelve a preguntar. Depende de `estado` para programar la consulta
  // siguiente cada vez que llega una respuesta, y de `reintentosEspera` cuando no llegó.
  useEffect(() => {
    if (!procesando) return
    const temporizador = window.setTimeout(async () => {
      const lectura = await cargar()
      if (lectura === 'fallida') setSinConexion(true)
      if (lectura !== 'aplicada') setReintentosEspera((n) => n + 1)
    }, INTERVALO_ESPERA_MS)
    return () => window.clearTimeout(temporizador)
  }, [procesando, estado, reintentosEspera, cargar])

  useEffect(() => {
    function alVolver() {
      // Con el celular bloqueado los temporizadores se frenan y otra pestaña pudo haber avanzado:
      // al volver se trae lo último.
      if (document.visibilityState !== 'visible') return
      if (trabajosRef.current === 0 && estadoRef.current) void cargar()
    }
    document.addEventListener('visibilitychange', alVolver)
    return () => document.removeEventListener('visibilitychange', alVolver)
  }, [cargar])

  useEffect(() => {
    if (!terminado) return
    // Terminado: no queda nada escrito en el dispositivo ni un «seguí donde quedaste» en el inicio.
    borrarBorradores(token)
    olvidarToken(token)
  }, [terminado, token])

  /** Qué hacer si la API no aceptó algo. Devuelve el mensaje para mostrar, si corresponde. */
  const tratarFalla = useCallback(
    async (err: unknown): Promise<string | null> => {
      if (err instanceof ErrorApi && err.estado === 404) {
        marcarLinkInvalido()
        return null
      }
      if (err instanceof ErrorApi && err.estado === 409) {
        // Otra pestaña avanzó o ya se está procesando algo: se trae lo último y se avisa.
        await cargar()
        setAviso(AVISO_OTRA_PESTANA)
        return null
      }
      return mensajeDe(err)
    },
    [cargar, marcarLinkInvalido],
  )

  const enviar = useCallback(
    async (entrada: Entrada): Promise<boolean> => {
      const actual = estadoRef.current
      if (!actual || trabajosRef.current > 0) return false
      empezarTrabajo()
      setError(null)
      setAviso(null)
      setUltimaEntrada(entrada)
      try {
        aplicarEstado(await mandarEntrada(token, entrada, actual.version))
        setMarcaGuardado((n) => n + 1)
        return true
      } catch (err) {
        setError(await tratarFalla(err))
        return false
      } finally {
        terminarTrabajo()
      }
    },
    [token, aplicarEstado, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const subirArchivo = useCallback(
    async (archivo: File): Promise<Resultado> => {
      empezarTrabajo()
      try {
        aplicarEstado(await subirArchivos(token, [archivo]))
        setMarcaGuardado((n) => n + 1)
        return { ok: true }
      } catch (err) {
        const mensaje = await tratarFalla(err)
        return {
          ok: false,
          error: mensaje ?? `«${archivo.name}» no se subió porque el cuestionario cambió en otra pestaña.`,
        }
      } finally {
        terminarTrabajo()
      }
    },
    [token, aplicarEstado, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const quitarArchivo = useCallback(
    async (id: string): Promise<Resultado> => {
      if (trabajosRef.current > 0) {
        return { ok: false, error: 'Esperá a que terminen de subir los archivos y probá de nuevo.' }
      }
      empezarTrabajo()
      try {
        aplicarEstado(await quitarArchivoApi(token, id))
        setMarcaGuardado((n) => n + 1)
        return { ok: true }
      } catch (err) {
        const mensaje = await tratarFalla(err)
        return { ok: false, error: mensaje ?? 'No se quitó porque el cuestionario cambió en otra pestaña.' }
      } finally {
        terminarTrabajo()
      }
    },
    [token, aplicarEstado, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const reintentar = useCallback(async () => {
    const pendiente = estadoRef.current?.entradaPendiente
    if (!pendiente) return
    setReintentando(true)
    await enviar(pendiente)
    setReintentando(false)
  }, [enviar])

  const reintentarCarga = useCallback(async () => {
    setReintentando(true)
    await cargar()
    setReintentando(false)
  }, [cargar])

  const acciones = useMemo(
    () => ({
      token,
      enviar,
      subirArchivo,
      quitarArchivo,
      ocupado: trabajos > 0 || procesando,
      error,
    }),
    [token, enviar, subirArchivo, quitarArchivo, trabajos, procesando, error],
  ) satisfies Omit<AccionesCuestionario, 'esperaEnLinea'>

  if (carga.tipo === 'cargando') {
    return (
      <Marco progreso={null}>
        <Cargando />
      </Marco>
    )
  }

  if (carga.tipo === 'invalido') {
    return (
      <Marco progreso={null}>
        <LinkInvalido />
      </Marco>
    )
  }

  if (carga.tipo === 'sin_conexion') {
    return (
      <Marco progreso={null}>
        <SinConexion
          mensaje={carga.mensaje}
          onReintentar={reintentarCarga}
          reintentando={reintentando}
        />
      </Marco>
    )
  }

  return (
    <VistaCuestionario
      estado={carga.estado}
      acciones={acciones}
      aviso={aviso}
      marcaGuardado={marcaGuardado}
      sinConexion={sinConexion}
      ultimaEntrada={ultimaEntrada}
      onReintentar={reintentar}
      reintentando={reintentando}
    />
  )
}

function mensajeDe(err: unknown): string {
  return err instanceof ErrorApi
    ? err.message
    : 'No se pudo completar. Recargá la página y probá de nuevo.'
}
