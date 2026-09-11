import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Entrada, Pantalla } from '@/lib/motor/tipos'

/** La pantalla de un tipo puntual: cada componente recibe solo los campos que le tocan. */
export type PantallaDe<T extends Pantalla['tipo']> = Extract<Pantalla, { tipo: T }>

/** Cómo terminó una subida o un quitar. El error ya viene listo para mostrar. */
export type Resultado = { ok: true } | { ok: false; error: string }

/**
 * Lo que una pantalla puede hacer. Lo arma `Cuestionario` contra la API y la galería de /demo
 * con manejadores de ejemplo: las pantallas no saben cuál de los dos las está usando.
 */
export interface AccionesCuestionario {
  /** Separa los borradores: lo escrito en un cuestionario no aparece en otro. */
  token: string
  /** true si el servidor aceptó la entrada. Si no, el motivo queda en `error`. */
  enviar: (entrada: Entrada) => Promise<boolean>
  subirArchivo: (archivo: File) => Promise<Resultado>
  quitarArchivo: (id: string) => Promise<Resultado>
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
