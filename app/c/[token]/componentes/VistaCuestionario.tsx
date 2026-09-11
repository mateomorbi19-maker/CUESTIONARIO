import { useEffect, useMemo, useRef } from 'react'
import type { EstadoPublico } from '@/lib/estado-publico'
import type { Entrada, Pantalla } from '@/lib/motor/tipos'
import { Confirmacion } from '../pantallas/Confirmacion'
import { Eleccion } from '../pantallas/Eleccion'
import { Entrevista } from '../pantallas/Entrevista'
import { Gracias } from '../pantallas/Gracias'
import { Material } from '../pantallas/Material'
import { PedidoChat } from '../pantallas/PedidoChat'
import { Pregunta } from '../pantallas/Pregunta'
import { PreguntaFinal } from '../pantallas/PreguntaFinal'
import { ProveedorCuestionario, type AccionesCuestionario } from './Contexto'
import { Espera } from './Espera'
import { FalloProceso } from './Estados'
import { Marco } from './Marco'
import { Aviso } from './Mensajes'

/** Para la galería de /demo: mostrar una pantalla con su desplegable ya abierto. */
export type ModoInicial = 'correccion' | 'cambio' | 'no_aplica'

interface Props {
  estado: EstadoPublico
  acciones: Omit<AccionesCuestionario, 'esperaEnLinea'>
  /** Un envío en camino que el servidor todavía no aceptó: arriba dice «Guardando…». */
  guardando?: boolean
  aviso?: string | null
  marcaGuardado?: number
  sinConexion?: boolean
  /** Lo último que mandó esta pestaña, por si el servidor no lo informa mientras procesa. */
  ultimaEntrada?: Entrada | null
  onReintentar: () => void
  reintentando?: boolean
  /** Galería de /demo: sin alto de pantalla completa y sin mover el foco ni el scroll. */
  compacto?: boolean
  modoInicial?: ModoInicial
}

/**
 * Decide qué se ve a partir del estado: la espera, el fallo con «Reintentar» o la pantalla. No
 * habla con la API: la usan `Cuestionario` y la galería de /demo por igual.
 */
export function VistaCuestionario({
  estado,
  acciones,
  guardando = false,
  aviso = null,
  marcaGuardado = 0,
  sinConexion = false,
  ultimaEntrada = null,
  onReintentar,
  reintentando = false,
  compacto = false,
  modoInicial,
}: Props) {
  const { pantalla } = estado
  const enLinea =
    estado.procesando &&
    pantalla.tipo === 'material' &&
    esCambioDeMaterial(estado.entradaPendiente ?? ultimaEntrada)

  let vista: 'espera' | 'fallo' | 'pantalla' = 'pantalla'
  if (estado.procesando && !enLinea) vista = 'espera'
  else if (estado.error && estado.entradaPendiente) vista = 'fallo'

  const identidad = vista === 'pantalla' ? identidadDe(pantalla) : vista
  const contenedor = useRef<HTMLDivElement>(null)
  const identidadAnterior = useRef<string | null>(null)

  useEffect(() => {
    const anterior = identidadAnterior.current
    identidadAnterior.current = identidad
    if (compacto || anterior === null || anterior === identidad) return
    // Pantalla nueva: arriba de todo y con el foco en su título, así un lector de pantalla la
    // anuncia y el teclado arranca desde la pregunta y no desde el botón que ya no existe.
    window.scrollTo(0, 0)
    contenedor.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [identidad, compacto])

  const accionesVista = useMemo<AccionesCuestionario>(
    () => ({
      ...acciones,
      esperaEnLinea: enLinea ? estado.mensajeEspera || 'Guardando…' : null,
    }),
    [acciones, enLinea, estado.mensajeEspera],
  )

  return (
    <ProveedorCuestionario acciones={accionesVista}>
      <Marco
        progreso={pantalla.tipo === 'gracias' ? null : estado.progreso}
        guardando={guardando}
        marcaGuardado={marcaGuardado}
        email={estado.email}
        aviso={aviso}
        centrado={vista === 'pantalla' && pantalla.tipo === 'gracias'}
        compacto={compacto}
      >
        <div ref={contenedor} className="vista">
          {vista === 'espera' && <Espera mensaje={estado.mensajeEspera} sinConexion={sinConexion} />}
          {vista === 'fallo' && (
            <FalloProceso
              mensaje={estado.error ?? ''}
              error={acciones.error}
              onReintentar={onReintentar}
              reintentando={reintentando}
            />
          )}
          {vista === 'pantalla' && (
            <>
              {/* Un fallo sin entrada para reintentar: se avisa y se puede volver a mandar. */}
              {estado.error && <Aviso texto={estado.error} />}
              <PantallaActual key={identidad} pantalla={pantalla} modoInicial={modoInicial} />
            </>
          )}
        </div>
      </Marco>
    </ProveedorCuestionario>
  )
}

function PantallaActual({ pantalla, modoInicial }: { pantalla: Pantalla; modoInicial?: ModoInicial }) {
  switch (pantalla.tipo) {
    case 'pregunta':
      return <Pregunta pantalla={pantalla} />
    case 'pedido_chat':
      return <PedidoChat pantalla={pantalla} />
    case 'eleccion':
      return <Eleccion pantalla={pantalla} />
    case 'confirmacion':
      return <Confirmacion pantalla={pantalla} corrigiendoAlInicio={modoInicial === 'correccion'} />
    case 'material':
      return <Material pantalla={pantalla} />
    case 'entrevista':
      return (
        <Entrevista
          pantalla={pantalla}
          modoInicial={modoInicial === 'cambio' || modoInicial === 'no_aplica' ? modoInicial : undefined}
        />
      )
    case 'pregunta_final':
      return <PreguntaFinal pantalla={pantalla} />
    case 'gracias':
      return <Gracias pantalla={pantalla} />
  }
}

/**
 * Qué hace que una pantalla sea «otra». Se usa como key: al cambiar, la pantalla se monta de
 * nuevo y arranca limpia (desplegables cerrados, borrador de su propia clave). El material no
 * cambia de identidad al sumar archivos, así no se pierden las subidas en curso.
 */
function identidadDe(pantalla: Pantalla): string {
  switch (pantalla.tipo) {
    case 'pregunta':
      return `pregunta:${pantalla.clave}:${pantalla.esRepregunta}:${pantalla.texto}`
    case 'entrevista':
      return `entrevista:${pantalla.pregunta.id}:${pantalla.repregunta ?? ''}:${pantalla.propuesta?.texto ?? ''}`
    case 'pregunta_final':
      return `final:${pantalla.numero}:${pantalla.texto}`
    case 'confirmacion':
      return `confirmacion:${pantalla.texto}`
    case 'eleccion':
      return `eleccion:${pantalla.texto}:${pantalla.opciones.join('|')}`
    default:
      return pantalla.tipo
  }
}

/** Pegar o quitar un texto del material: cambios chicos que no justifican tapar la pantalla. */
function esCambioDeMaterial(entrada: Entrada | null): boolean {
  return entrada?.tipo === 'texto_material' || entrada?.tipo === 'quitar_texto'
}
