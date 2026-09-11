import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { quitarArchivo } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string; id: string }> }

export async function DELETE(_req: Request, { params }: Ctx) {
  const { token, id } = await params
  try {
    return NextResponse.json(await quitarArchivo(token, id))
  } catch (err) {
    return errorApi('archivos:DELETE', err, 'No se pudo quitar el archivo. Probá de nuevo.')
  }
}
