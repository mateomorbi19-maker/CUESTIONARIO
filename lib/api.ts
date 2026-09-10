import { NextResponse } from 'next/server'
import { ErrorBaseDeDatos, traducirErrorBase } from './db'

/**
 * Respuesta de error uniforme.
 *
 * Los problemas de configuración se devuelven con su mensaje real: sin eso, un
 * DATABASE_URL mal puesto se ve igual que un bug y no hay forma de saber qué arreglar.
 * Los errores inesperados quedan genéricos hacia afuera y con detalle en el log.
 */
export function errorApi(contexto: string, err: unknown, mensajeGenerico: string): NextResponse {
  const base = err instanceof ErrorBaseDeDatos ? err : traducirErrorBase(err)

  if (base) {
    console.error(`[${contexto}] base de datos (${base.causa}):`, base.message)
    return NextResponse.json(
      {
        error: base.message,
        tipo: 'configuracion',
        causa: base.causa,
        ayuda: 'Revisá el estado del sistema en /api/salud',
      },
      { status: 503 },
    )
  }

  console.error(`[${contexto}]`, err)
  return NextResponse.json({ error: mensajeGenerico, tipo: 'interno' }, { status: 500 })
}
