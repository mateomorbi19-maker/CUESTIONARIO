import { createContext, useContext, useState, type ReactNode } from 'react'
import type { DestinoSubida, OpcionesSubida } from '@/lib/cliente-api'
import type { DetalleSubida, MotivoError } from '@/lib/estado-publico'
import type { Entrada, Pantalla } from '@/lib/motor/tipos'

/** La pantalla de un tipo puntual: cada componente recibe solo los campos que le tocan. */
export type PantallaDe<T extends Pantalla['tipo']> = Extract<Pantalla, { tipo: T }>

/** Cómo terminó un quitar o un cambio de nombre. El error ya viene listo para mostrar. */
export type Resultado = { ok: true } | { ok: false; error: string }

/**
 * Cómo terminó la subida de un archivo. Si salió bien trae el detalle: cuántos se agregaron (un
 * .zip suma uno por cada archivo de adentro), cuántos ya estaban y qué no se pudo sacar.
 */
export type ResultadoUi =
  | ({ ok: true } & DetalleSubida)
  /** `motivo`: para lo que la fila de subidas resuelve sola, como pasar el lote a «Nombre (2)». */
  | { ok: false; error: string; motivo?: MotivoError }

/**
 * Lo que una pantalla puede hacer. Lo arma `Cuestionario` contra la API y la galería de /demo
 * con manejadores de ejemplo: las pantallas no saben cuál de los dos las está usando.
 */
export interface AccionesCuestionario {
  /** Separa los borradores: lo escrito en un cuestionario no aparece en otro. */
  token: string
  /** true si el servidor aceptó la entrada. Si no, el motivo queda en `error`. */
  enviar: (entrada: Entrada) => Promise<boolean>
  /** Lo llama la fila de subidas (SubidaDeArchivos), de a un archivo: las pantallas encolan ahí. */
  subirArchivo: (archivo: File, destino: DestinoSubida, opciones?: OpcionesSubida) => Promise<ResultadoUi>
  /** Deja de lado una subida que quedó a medias: el servidor borra lo que ya había recibido. */
  descartarSubida: (archivo: File) => void
  quitarArchivo: (id: string) => Promise<Resultado>
  /** Quita todos los archivos de esa conversación. null: los sueltos. */
  quitarConversacion: (grupo: string | null) => Promise<Resultado>
  renombrarConversacion: (grupo: string, nombre: string) => Promise<Resultado>
  /** Vuelve a pedir el estado: mientras se escuchan audios, para ver cuándo terminaron. */
  recargar: () => Promise<void>
  /** Hay algo en camino o procesándose: los botones que mandan esperan. */
  ocupado: boolean
  /** Por qué no se aceptó el último envío. Va junto al formulario. */
  error: string | null
  /**
   * Mientras se procesa un cambio chico del material (pegar o quitar un texto), la pantalla
   * sigue a la vista con este mensaje en lugar de taparla con la espera. null si no hay nada.
   */
  esperaEnLinea: string | null
}

const Contexto = createContext<AccionesCuestionario | null>(null)

export function ProveedorCuestionario({
  acciones,
  children,
}: {
  acciones: AccionesCuestionario
  children: ReactNode
}) {
  return <Contexto value={acciones}>{children}</Contexto>
}

export function useCuestionario(): AccionesCuestionario {
  const acciones = useContext(Contexto)
  if (!acciones) {
    throw new Error('Las pantallas del cuestionario van dentro de <ProveedorCuestionario>.')
  }
  return acciones
}

/**
 * Manda entradas recordando qué botón las mandó: solo ese dice «Guardando…» y el error aparece
 * al lado del que se tocó.
 */
export function useEnvio() {
  const { enviar, ocupado, error } = useCuestionario()
  const [enCurso, setEnCurso] = useState<string | null>(null)
  const [ultimo, setUltimo] = useState<string | null>(null)

  async function mandar(boton: string, entrada: Entrada): Promise<boolean> {
    if (ocupado) return false
    setEnCurso(boton)
    setUltimo(boton)
    try {
      return await enviar(entrada)
    } finally {
      setEnCurso(null)
    }
  }

  /** El error, solo si el último envío salió de un botón cuyo nombre empieza así. */
  function errorDe(...botones: string[]): string | null {
    return ultimo !== null && botones.some((boton) => ultimo.startsWith(boton)) ? error : null
  }

  return { mandar, enCurso, ocupado, error, errorDe }
}
