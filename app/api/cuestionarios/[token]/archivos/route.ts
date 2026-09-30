import { NextResponse } from 'next/server'
import { errorApi } from '@/lib/api'
import { ErrorCuestionario } from '@/lib/cuestionarios'
import { leerCuestionario, subirArchivos } from '@/lib/proceso'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

// formData() carga el pedido entero en memoria. Los archivos grandes van por partes (ver
// /subidas): acá solo llegan los chicos, con margen para una pantalla vieja que todavía mande
// todo en un pedido.
const LIMITE_BYTES_PEDIDO = 25 * 1024 * 1024

/**
 * Sube uno o varios archivos chicos. multipart/form-data con "archivos", "grupo" (la conversación;
 * vacío o ausente: sueltos) y "grupoElegido" ('1' si la eligió la persona). Ver docs/API.md.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params
  try {
    // Antes de leer nada: un link inválido tiene que dar su 404, no un error de subida.
    await leerCuestionario(token)
    if (Number(req.headers.get('content-length') ?? 0) > LIMITE_BYTES_PEDIDO) {
      throw new ErrorCuestionario('El archivo es demasiado grande para subirlo de una vez. Recargá la página y subilo de nuevo.', 400)
    }
    let formulario: FormData
    try {
      formulario = await req.formData()
    } catch {
      // El proxy corta los pedidos que tardan más de un minuto en llegar: el cuerpo queda a medias.
      throw new ErrorCuestionario('La subida se cortó antes de terminar. Probá de nuevo; si se repite, probá con otra conexión.', 400)
    }
    const archivos = formulario.getAll('archivos').filter((valor): valor is File => valor instanceof File)
    const grupo = formulario.get('grupo')
    return NextResponse.json(await subirArchivos(token, archivos, typeof grupo === 'string' ? grupo : null, formulario.get('grupoElegido') === '1'))
  } catch (err) {
    return errorApi('archivos:POST', err, 'No se pudo subir el archivo. Probá de nuevo.')
  }
}
