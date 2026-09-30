import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { quitarConversacion, renombrarConversacion } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

// El nombre de la conversación va siempre en el cuerpo y nunca en la URL: suele traer el nombre
// y el teléfono de un cliente, y las URL quedan en los registros del proxy.

async function cuerpoDe(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
}

/** Cambia el nombre de una conversación: { grupo, nombre }. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    const cuerpo = await cuerpoDe(req)
    return NextResponse.json(await renombrarConversacion(token, cuerpo.grupo, cuerpo.nombre))
  } catch (err) {
    return errorApi('conversaciones:PATCH', err, 'No se pudo cambiar el nombre. Probá de nuevo.')
  }
}

/** Quita una conversación entera: { grupo }. Con grupo null, los archivos sueltos. */
export async function DELETE(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    const cuerpo = await cuerpoDe(req)
    return NextResponse.json(await quitarConversacion(token, typeof cuerpo.grupo === 'string' ? cuerpo.grupo : null))
  } catch (err) {
    return errorApi('conversaciones:DELETE', err, 'No se pudo quitar la conversación. Probá de nuevo.')
  }
}
