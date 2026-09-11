'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ErrorApi, borrarBorradores, guardarToken, leerEstado, olvidarToken } from '@/lib/cliente-api'
import type { EstadoPublico } from '@/lib/estado-publico'
import { BarraDeProgreso } from './BarraDeProgreso'
import { Cargando, LinkInvalido, SinConexion } from './Estados'
import { IconoCheck } from './Iconos'

export function rutaPreguntas(token: string): string {
  return `/c/${encodeURIComponent(token)}/preguntas`
}

type Carga =
  | { tipo: 'cargando' }
  | { tipo: 'invalido' }
  | { tipo: 'sin_conexion'; mensaje: string }
  | { tipo: 'listo'; estado: EstadoPublico }

interface Props {
  token: string
  /** Lo que va debajo del botón. En el inicio general: «Empezar un cuestionario nuevo». */
  extra?: ReactNode
  /**
   * En el inicio general: el link ya no existe o el cuestionario terminó, así que se deja de
   * mostrar y aparece el formulario. Sin esto se muestra el aviso que corresponde.
   */
  onDescartar?: (token: string) => void
}

/**
 * El mini inicio de un cuestionario: de qué negocio es, cuánto avanzó y un solo botón para entrar
 * a las preguntas. Es a donde lleva el link del mail y lo que ve en el inicio quien vuelve al
 * mismo dispositivo: antes de caer en una pregunta, ve que está todo guardado.
 */
export function InicioCuestionario({ token, extra, onDescartar }: Props) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' })
  const [reintentando, setReintentando] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const estado = await leerEstado(token)
      if (estado.etapa === 'terminado') {
        // Terminado: no queda nada escrito en el dispositivo ni un «seguí donde quedaste».
        borrarBorradores(token)
        olvidarToken(token)
        onDescartar?.(token)
      } else {
        guardarToken(token)
      }
      setCarga({ tipo: 'listo', estado })
    } catch (err) {
      if (err instanceof ErrorApi && err.estado === 404) {
        olvidarToken(token)
        onDescartar?.(token)
        setCarga({ tipo: 'invalido' })
      } else {
        setCarga({
          tipo: 'sin_conexion',
          mensaje: err instanceof ErrorApi ? err.message : 'No se pudo abrir tu cuestionario. Probá de nuevo.',
        })
      }
    }
  }, [token, onDescartar])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function reintentar() {
    setReintentando(true)
    await cargar()
    setReintentando(false)
  }

  if (carga.tipo === 'cargando') return <Cargando />
  if (carga.tipo === 'invalido') return <LinkInvalido />
  if (carga.tipo === 'sin_conexion') {
    return <SinConexion mensaje={carga.mensaje} onReintentar={reintentar} reintentando={reintentando} />
  }

  const { estado } = carga
  if (estado.pantalla.tipo === 'gracias') {
    return (
      <div className="inicio-cabeza">
        <span className="inicio-marca" aria-hidden="true">
          <IconoCheck width={28} height={28} />
        </span>
        <h1 className="inicio-titulo">Terminaste el cuestionario</h1>
        <p>{estado.pantalla.texto}</p>
      </div>
    )
  }

  const empezo =
    estado.etapa !== 'triage' ||
    estado.progreso.porcentaje > 0 ||
    (estado.pantalla.tipo === 'pregunta' && estado.pantalla.esRepregunta)

  return (
    <>
      <div className="inicio-cabeza">
        <p className="antetitulo">Tu cuestionario</p>
        <h1 className="inicio-titulo">{estado.negocio}</h1>
        <p className="inicio-guardado">
          <IconoCheck />
          Todo lo que contestás se guarda solo. Podés cerrar y seguir cuando quieras.
        </p>
      </div>

      <div className="empezado">
        <p className="empezado-negocio">Progreso de la entrevista</p>
        <BarraDeProgreso porcentaje={estado.progreso.porcentaje} texto={estado.progreso.texto} />
      </div>

      <div className="acciones">
        <Link className="boton boton-principal" href={rutaPreguntas(token)}>
          {empezo ? 'Seguir con las preguntas' : 'Empezar las preguntas'}
        </Link>
      </div>

      {extra}
    </>
  )
}
