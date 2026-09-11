import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { estadoPublico, leerCuestionario } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

/** El estado del cuestionario para la pantalla. La pantalla lo pide cada 2 segundos mientras procesa. */
export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    return NextResponse.json(estadoPublico(await leerCuestionario(token)), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return errorApi('cuestionario:GET', err, 'No se pudo leer el cuestionario. Probá recargar la página.')
  }
}
