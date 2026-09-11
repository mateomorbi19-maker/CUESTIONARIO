import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { subirArchivos } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

/** Sube uno o varios archivos al material. Campo "archivos" de un multipart/form-data. */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    const formulario = await req.formData().catch(() => null)
    const archivos = (formulario?.getAll('archivos') ?? []).filter((valor): valor is File => valor instanceof File)
    return NextResponse.json(await subirArchivos(token, archivos))
  } catch (err) {
    return errorApi('archivos:POST', err, 'No se pudo subir el archivo. Probá de nuevo.')
  }
}
