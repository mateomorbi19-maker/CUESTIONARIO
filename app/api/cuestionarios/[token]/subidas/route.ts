import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { crearSubida } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

/**
 * Abre una subida por partes: { nombre, bytes, grupo, grupoElegido }. Si ya había una abierta del
 * mismo archivo, devuelve esa con lo que tiene recibido, para seguir desde ahí. Ver docs/API.md.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    const cuerpo = await req.json().catch(() => null)
    return NextResponse.json(await crearSubida(token, cuerpo), { status: 201 })
  } catch (err) {
    return errorApi('subidas:POST', err, 'No se pudo empezar la subida. Probá de nuevo.')
  }
}
