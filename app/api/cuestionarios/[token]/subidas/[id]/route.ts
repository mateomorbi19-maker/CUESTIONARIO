import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { ErrorCuestionario } from '@/lib/cuestionarios'
import { TAMANO_PARTE } from '@/lib/limites'
import { cancelarSubida, recibirParte } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string; id: string }> }

const MENSAJE_PARTE_GRANDE = 'La parte que se mandó es demasiado grande. Recargá la página y probá de nuevo.'

/** Lee el cuerpo sin pasar de TAMANO_PARTE, venga o no el largo declarado: nadie puede llenar la memoria con un PUT. */
async function leerParte(req: Request): Promise<Buffer> {
  if (Number(req.headers.get('content-length') ?? 0) > TAMANO_PARTE) throw new ErrorCuestionario(MENSAJE_PARTE_GRANDE, 400)
  if (!req.body) return Buffer.alloc(0)
  const partes: Uint8Array[] = []
  let total = 0
  const lector = req.body.getReader()
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    total += value.length
    if (total > TAMANO_PARTE) {
      await lector.cancel().catch(() => undefined)
      throw new ErrorCuestionario(MENSAJE_PARTE_GRANDE, 400)
    }
    partes.push(value)
  }
  return Buffer.concat(partes)
}

/** Recibe una parte: los bytes crudos, que van en la posición ?desde=. Repetir la misma parte no rompe nada. */
export async function PUT(req: Request, { params }: Ctx) {
  const { token, id } = await params
  try {
    const crudo = new URL(req.url).searchParams.get('desde') ?? ''
    // Number('') da 0 y Number('1.5') pasaría: solo valen dígitos.
    if (!/^\d{1,15}$/.test(crudo)) {
      throw new ErrorCuestionario('La parte no dice desde dónde va. Recargá la página y subí el archivo de nuevo.', 400)
    }
    let datos: Buffer
    try {
      datos = await leerParte(req)
    } catch (err) {
      if (err instanceof ErrorCuestionario) throw err
      throw new ErrorCuestionario('La subida se cortó antes de terminar. Probá de nuevo; si se repite, probá con otra conexión.', 400)
    }
    return NextResponse.json(await recibirParte(token, id, Number(crudo), datos))
  } catch (err) {
    return errorApi('subidas:PUT', err, 'No se pudo recibir esa parte del archivo. Probá de nuevo.')
  }
}

/** Cancela la subida y borra lo recibido. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { token, id } = await params
  try {
    await cancelarSubida(token, id)
    return NextResponse.json({})
  } catch (err) {
    return errorApi('subidas:DELETE', err, 'No se pudo cancelar la subida. Probá de nuevo.')
  }
}
