import { NextResponse } from 'next/server'
import { ErrorArchivo } from './archivos'
import { ErrorCuestionario } from './cuestionarios'
import { ErrorBaseDeDatos, traducirErrorBase } from './db'
import { ErrorEntrada } from './motor/motor'

/**
 * Respuesta de error uniforme.
 *
 * Los errores del cliente (datos inválidos, link vencido, otra pestaña) vuelven con su mensaje,
 * que ya dice qué hacer. Los problemas de configuración también: sin eso, un DATABASE_URL mal
 * puesto se ve igual que un bug. Los errores inesperados quedan genéricos hacia afuera y con
 * detalle en el log.
 */
export function errorApi(contexto: string, err: unknown, mensajeGenerico: string): NextResponse {
  if (err instanceof ErrorCuestionario) {
    return NextResponse.json({ error: err.message }, { status: err.estadoHttp })
  }
  if (err instanceof ErrorEntrada || err instanceof ErrorArchivo) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }

  const base = err instanceof ErrorBaseDeDatos ? err : traducirErrorBase(err)
  if (base) {
    console.error(`[${contexto}] base de datos (${base.causa}):`, base.message)
    return NextResponse.json(
      {
        error: 'El servicio no está disponible en este momento. Probá de nuevo en un rato.',
        tipo: 'configuracion',
        causa: base.causa,
        ayuda: 'Revisá el estado del sistema en /api/salud',
      },
      { status: 503 },
    )
  }

  console.error(`[${contexto}]`, err)
  return NextResponse.json({ error: mensajeGenerico }, { status: 500 })
}
