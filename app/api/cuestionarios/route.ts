import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { empezarCuestionario } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Crea un cuestionario desde el link general. Ver docs/API.md. */
export async function POST(req: Request) {
  try {
    const cuerpo = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const texto = (valor: unknown) => (typeof valor === 'string' ? valor : '')
    const resultado = await empezarCuestionario({
      codigo: texto(cuerpo.codigo),
      negocio: texto(cuerpo.negocio),
      email: texto(cuerpo.email),
    })
    // 201 si se abrió uno nuevo; 200 si ese mail ya tenía uno empezado y se le mandó el link.
    return NextResponse.json(resultado, { status: 'token' in resultado ? 201 : 200 })
  } catch (err) {
    return errorApi('cuestionarios:POST', err, 'No se pudo crear el cuestionario. Probá de nuevo en un rato.')
  }
}
