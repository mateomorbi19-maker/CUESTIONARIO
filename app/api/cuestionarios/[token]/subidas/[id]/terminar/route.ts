import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { terminarSubida } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string; id: string }> }

/**
 * Cierra una subida por partes: el archivo entra al material y, si es un .zip, se abre. Repetirlo
 * después de un éxito devuelve el mismo resultado. Ver docs/API.md.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { token, id } = await params
  try {
    return NextResponse.json(await terminarSubida(token, id))
  } catch (err) {
    return errorApi('subidas:terminar', err, 'No se pudo terminar la subida. Probá de nuevo: lo que ya subió no se pierde.')
  }
}
