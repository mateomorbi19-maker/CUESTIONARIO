import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { recibirEntrada } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

/** Recibe una entrada y la pone a procesar en segundo plano. Ver docs/API.md. */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    const cuerpo = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const estado = await recibirEntrada(token, cuerpo.entrada, cuerpo.version)
    return NextResponse.json(estado, { status: 202 })
  } catch (err) {
    return errorApi('entrada:POST', err, 'No se pudo guardar tu respuesta. Probá de nuevo.')
  }
}
