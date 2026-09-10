import { createHash, randomBytes } from 'node:crypto'
import type { RegistroLlamada } from './claude'
import { db } from './db'
import { estadoInicial } from './motor/motor'
import type { EstadoCuestionario } from './motor/tipos'

/**
 * Guardar y recuperar cuestionarios.
 *
 * El cliente entra con un token que va en su link personal. En la base se guarda solo el
 * hash: quien lea la tabla no puede entrar a ningún cuestionario.
 */

export interface Cuestionario {
  id: string
  negocio: string
  email: string
  estado: EstadoCuestionario
  version: number
}

export class ErrorCuestionario extends Error {
  constructor(
    message: string,
    readonly estadoHttp: 400 | 404 | 409,
  ) {
    super(message)
    this.name = 'ErrorCuestionario'
  }
}

function hashDe(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function nuevoId(): string {
  const alfabeto = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // sin 0/O/1/I, para poder dictarlo
  let id = ''
  for (const b of randomBytes(8)) id += alfabeto[b % alfabeto.length]
  return `CUE-${id}`
}

interface Fila {
  id: string
  negocio: string
  email: string
  estado: EstadoCuestionario
  version: number
}

export async function crearCuestionario(negocio: string, email: string): Promise<{ cuestionario: Cuestionario; token: string }> {
  const nombre = negocio.trim()
  const correo = email.trim()
  if (!nombre) throw new ErrorCuestionario('Falta el nombre del negocio.', 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new ErrorCuestionario('El mail no tiene un formato válido.', 400)

  // 24 bytes al azar: imposible de adivinar, y en base64url entra entero en un link.
  const token = randomBytes(24).toString('base64url')
  const estado = estadoInicial(nombre)
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    `INSERT INTO cuestionarios (id, negocio, email, etapa, estado, token_sha256)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, negocio, email, estado, version`,
    [nuevoId(), nombre, correo, estado.etapa, JSON.stringify(estado), hashDe(token)],
  )
  return { cuestionario: rows[0], token }
}

export async function buscarPorToken(token: string): Promise<Cuestionario | null> {
  if (!token) return null
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    'SELECT id, negocio, email, estado, version FROM cuestionarios WHERE token_sha256 = $1',
    [hashDe(token)],
  )
  return rows[0] ?? null
}

/**
 * Guarda el estado nuevo solo si nadie lo cambió desde que se leyó.
 *
 * Si el cliente tiene el cuestionario abierto en dos pestañas y manda desde las dos, la
 * segunda escritura pierde en vez de pisar respuestas que no vio.
 */
export async function guardarEstado(cuestionario: Cuestionario, estado: EstadoCuestionario): Promise<Cuestionario> {
  const base = await db()
  const { rows } = await base.consulta<{ version: number }>(
    `UPDATE cuestionarios
        SET estado = $1::jsonb, etapa = $2, version = version + 1, actualizado_en = now()
      WHERE id = $3 AND version = $4
      RETURNING version`,
    [JSON.stringify(estado), estado.etapa, cuestionario.id, cuestionario.version],
  )
  if (!rows[0]) {
    throw new ErrorCuestionario('El cuestionario cambió en otra pestaña o dispositivo. Recargá la página para seguir desde donde quedó.', 409)
  }
  return { ...cuestionario, estado, version: rows[0].version }
}

/**
 * Registro de cada llamada a Claude. Si el registro falla, el cuestionario sigue: perder una
 * fila de costos no puede frenar a un cliente en la mitad.
 */
export function registradorDeLlamadas(cuestionarioId: string | null) {
  return async (r: RegistroLlamada): Promise<void> => {
    try {
      const base = await db()
      await base.consulta(
        `INSERT INTO llamadas_ia (cuestionario_id, paso, modelo, stop_reason, tokens_entrada, tokens_salida,
                                  tokens_cache_escritos, tokens_cache_leidos, duracion_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          cuestionarioId,
          r.paso,
          r.modelo,
          r.stopReason,
          r.tokensEntrada,
          r.tokensSalida,
          r.tokensCacheEscritos,
          r.tokensCacheLeidos,
          r.duracionMs,
          r.error,
        ],
      )
    } catch (err) {
      console.error('[llamadas_ia] no se pudo registrar la llamada:', err)
    }
  }
}
