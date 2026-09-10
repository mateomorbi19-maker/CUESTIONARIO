import { NextResponse } from 'next/server'
import { estadoBase } from '@/lib/db'
import { estadoSkills } from '@/lib/skills'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Comprobación de salud. Primer lugar donde mirar cuando algo no anda: dice si la base
 * responde, si la imagen trae las skills y qué variables faltan cargar.
 *
 *   curl http://localhost:3000/api/salud
 *
 * Es pública, así que de cada variable dice si está definida y nunca su valor.
 */
export async function GET() {
  const [base, skills] = await Promise.all([estadoBase(), estadoSkills()])

  // Todavía no frenan el ok general: el motor, el acceso y el mail llegan en fases
  // siguientes. Se informan desde ahora para cargarlas en Easypanel de una sola vez.
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
  return NextResponse.json({ ok, base, skills, variables }, { status: ok ? 200 : 503 })
}
