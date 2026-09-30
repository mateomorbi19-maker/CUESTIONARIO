'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ErrorApi,
  borrarBorradores,
  descartarSubida as descartarSubidaApi,
  guardarToken,
  leerEstado,
  mandarEntrada,
  olvidarToken,
  quitarArchivo as quitarArchivoApi,
  quitarConversacion as quitarConversacionApi,
  renombrarConversacion as renombrarConversacionApi,
  subirArchivo as subirArchivoApi,
  type DestinoSubida,
  type OpcionesSubida,
} from '@/lib/cliente-api'
import type { EstadoPublico, ResultadoSubida } from '@/lib/estado-publico'
import type { Entrada } from '@/lib/motor/tipos'
import type { AccionesCuestionario, Resultado, ResultadoUi } from './componentes/Contexto'
import { Cargando, LinkInvalido, SinConexion } from './componentes/Estados'
import { Marco } from './componentes/Marco'
import { ProveedorDeSubidas } from './componentes/SubidaDeArchivos'
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
 * entradas, esperar mientras se procesa, subir y quitar archivos y conversaciones, y qué hacer con
 * cada error. Lo que se ve lo decide `VistaCuestionario`, que también usa la galería de /demo.
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

  /**
   * Qué hacer si la API no aceptó algo. Devuelve el mensaje para mostrar, o null si no hay nada
   * que decir porque la pantalla ya cambió sola.
   */
  const tratarFalla = useCallback(
    async (err: unknown): Promise<string | null> => {
      if (!(err instanceof ErrorApi)) return mensajeDe(err)
      // Solo el 404 es el link: una subida vencida o un archivo que ya no está llegan con otro
      // código, y tratarlos como link inválido dejaría a la persona afuera del cuestionario.
      if (err.estado === 404) {
        marcarLinkInvalido()
        return null
      }
      if (err.estado !== 409) return err.message
      // Lo que se ve quedó viejo: se trae lo último y después se decide qué decir.
      await cargar()
      if (err.motivo === 'ya_no_esta') return null
      if (err.motivo === 'version') {
        setAviso(AVISO_OTRA_PESTANA)
        return null
      }
      // Se está procesando, el paso ya no admite archivos: el servidor dice cuál y qué hacer.
      return err.message
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
        if (err instanceof ErrorApi && err.estado === 409) {
          // En una entrada, un 409 es que otra pestaña avanzó o que ya se está procesando algo: se
          // trae lo último y se avisa. Reintentarla sola podría contestar otra pregunta.
          await cargar()
          setAviso(AVISO_OTRA_PESTANA)
        } else {
          setError(await tratarFalla(err))
        }
        return false
      } finally {
        terminarTrabajo()
      }
    },
    [token, aplicarEstado, cargar, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const subirArchivo = useCallback(
    async (archivo: File, destino: DestinoSubida, opciones?: OpcionesSubida): Promise<ResultadoUi> => {
      empezarTrabajo()
      try {
        let resultado: ResultadoSubida
        try {
          resultado = await subirArchivoApi(token, archivo, destino, opciones)
        } catch (err) {
          if (!(err instanceof ErrorApi) || err.motivo !== 'version') throw err
          // Otra pestaña guardó justo en el medio. Lo subido no se perdió: se trae lo último y se
          // prueba una vez más, que sigue desde donde quedó.
          await cargar()
          resultado = await subirArchivoApi(token, archivo, destino, opciones)
        }
        // La respuesta es el estado con el detalle de la subida al lado.
        const { subida, ...estadoNuevo } = resultado
        aplicarEstado(estadoNuevo)
        setMarcaGuardado((n) => n + 1)
        return { ok: true, ...subida }
      } catch (err) {
        const mensaje = await tratarFalla(err)
        return {
          ok: false,
          error: mensaje ?? `«${archivo.name}» no se subió. Tocá «Reintentar».`,
          motivo: err instanceof ErrorApi ? err.motivo : undefined,
        }
      } finally {
        terminarTrabajo()
      }
    },
    [token, aplicarEstado, cargar, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const descartarSubida = useCallback(
    (archivo: File) => {
      void descartarSubidaApi(token, archivo)
    },
    [token],
  )

  /** Quitar y renombrar: cambios chicos que devuelven el estado nuevo. */
  const cambiarMaterial = useCallback(
    async (pedido: () => Promise<EstadoPublico>): Promise<Resultado> => {
      if (trabajosRef.current > 0) {
        return { ok: false, error: 'Esperá a que terminen de subir los archivos y probá de nuevo.' }
      }
      empezarTrabajo()
      try {
        let nuevo: EstadoPublico
        try {
          nuevo = await pedido()
        } catch (err) {
          if (!(err instanceof ErrorApi) || err.motivo !== 'version') throw err
          await cargar()
          nuevo = await pedido()
        }
        aplicarEstado(nuevo)
        setMarcaGuardado((n) => n + 1)
        return { ok: true }
      } catch (err) {
        const mensaje = await tratarFalla(err)
        if (mensaje !== null) return { ok: false, error: mensaje }
        // Ya no estaba (se quitó desde otra pestaña): la pantalla se puso al día y no hay error.
        if (err instanceof ErrorApi && err.motivo === 'ya_no_esta') return { ok: true }
        return { ok: false, error: 'No se guardó porque el cuestionario cambió mientras tanto. Probá de nuevo.' }
      } finally {
        terminarTrabajo()
      }
    },
    [aplicarEstado, cargar, empezarTrabajo, terminarTrabajo, tratarFalla],
  )

  const quitarArchivo = useCallback(
    (id: string) => cambiarMaterial(() => quitarArchivoApi(token, id)),
    [token, cambiarMaterial],
  )

  const quitarConversacion = useCallback(
    (grupo: string | null) => cambiarMaterial(() => quitarConversacionApi(token, grupo)),
    [token, cambiarMaterial],
  )

  const renombrarConversacion = useCallback(
    (grupo: string, nombre: string) => cambiarMaterial(() => renombrarConversacionApi(token, grupo, nombre)),
    [token, cambiarMaterial],
  )

  const recargar = useCallback(async () => {
    // Con algo en camino, la respuesta de eso ya trae el estado nuevo.
    if (trabajosRef.current === 0) await cargar()
  }, [cargar])

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
      descartarSubida,
      quitarArchivo,
      quitarConversacion,
      renombrarConversacion,
      recargar,
      ocupado: trabajos > 0 || procesando,
      error,
    }),
    [
      token,
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
    // Por encima del cambio de vistas: la fila de subidas y lo que falló, con su «Reintentar»,
    // siguen ahí aunque la pantalla pase por una espera y vuelva.
    <ProveedorDeSubidas acciones={acciones} pantalla={carga.estado.pantalla}>
      <VistaCuestionario
        estado={carga.estado}
        acciones={acciones}
        guardando={trabajos > 0}
        aviso={aviso}
        marcaGuardado={marcaGuardado}
        sinConexion={sinConexion}
        ultimaEntrada={ultimaEntrada}
        onReintentar={reintentar}
        reintentando={reintentando}
      />
    </ProveedorDeSubidas>
  )
}

function mensajeDe(err: unknown): string {
  return err instanceof ErrorApi
    ? err.message
    : 'No se pudo completar. Recargá la página y probá de nuevo.'
}
