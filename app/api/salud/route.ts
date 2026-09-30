import { NextResponse } from 'next/server'
import { faltaParaCorreo } from '@/lib/correo'
import { estadoBase } from '@/lib/db'
import { estadoMultimedia } from '@/lib/multimedia'
import { estadoSkills } from '@/lib/skills'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Comprobación de salud. Primer lugar donde mirar cuando algo no anda: dice si la base
 * responde, si la imagen trae las skills, si se pueden escuchar audios y videos, y qué falta
 * para poder mandarle el link a un cliente.
 *
 *   curl http://localhost:3000/api/salud
 *
 * Es pública, así que de cada variable dice si está definida y nunca su valor.
 */
export async function GET() {
  const [base, skills, multimedia] = await Promise.all([estadoBase(), estadoSkills(), estadoMultimedia()])
  const correo = faltaParaCorreo()

  // Sin esto la app arranca, pero un cliente no puede completar el cuestionario de punta a
  // punta o Mateo no recibe los entregables.
  const faltan: string[] = []
  if (!process.env.ANTHROPIC_API_KEY) faltan.push('ANTHROPIC_API_KEY: sin ella no se puede conducir el cuestionario.')
  if (!process.env.CODIGO_ACCESO) faltan.push('CODIGO_ACCESO: sin él no se puede empezar ningún cuestionario en producción.')
  if (correo) faltan.push(`Correo: ${correo}`)
  if (!process.env.MAIL_AVISO) faltan.push('MAIL_AVISO: sin él los entregables no le llegan a nadie.')
  if (!process.env.URL_PUBLICA) faltan.push('URL_PUBLICA: sin ella el mail al cliente no puede llevar su link.')

  const variables = Object.fromEntries(
    [
      'DATABASE_URL',
      'ANTHROPIC_API_KEY',
      'CODIGO_ACCESO',
      'URL_PUBLICA',
      'SMTP_HOST',
      'SMTP_USUARIO',
      'SMTP_CLAVE',
      'SMTP_REMITENTE',
      'MAIL_AVISO',
    ].map((nombre) => [nombre, process.env[nombre] ? 'definida' : 'FALTA']),
  )

  const ok = base.ok && skills.ok
  // Se decide antes de sumar lo de audios y videos: sin transcriptor la app sigue atendiendo, y
  // el audio queda con su nota. Que falte se ve en `faltan` y en `multimedia`, pero no frena a nadie.
  const listoParaClientes = ok && faltan.length === 0
  for (const detalle of [multimedia.ffmpeg, multimedia.transcriptor, multimedia.modelo]) {
    if (detalle !== 'ok') faltan.push(`Audios y videos: ${detalle.replace(/\.$/, '')}. Sin esto quedan sin escuchar.`)
  }
  return NextResponse.json(
    {
      ok,
      listoParaClientes,
      faltan,
      base,
      skills,
      multimedia,
      correo: { ok: correo === null, detalle: correo ?? 'Servidor de correo configurado.' },
      variables,
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
