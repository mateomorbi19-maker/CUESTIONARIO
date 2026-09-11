import { createHash, randomBytes } from 'node:crypto'
import type { RegistroLlamada, VidaCache } from './claude'
import type { ConsumoLlamada } from './costos'
import { db } from './db'
import { estadoInicial } from './motor/motor'
import type { Entrada, EstadoCuestionario } from './motor/tipos'

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
  /** Desde cuándo se está procesando una entrada, o null. */
  procesandoDesde: Date | null
  ultimoError: string | null
  entradaPendiente: Entrada | null
  avisoEnviadoEn: Date | null
}

export class ErrorCuestionario extends Error {
  constructor(
    message: string,
    readonly estadoHttp: 400 | 403 | 404 | 409 | 429,
  ) {
    super(message)
    this.name = 'ErrorCuestionario'
  }
}

/** Pasado este tiempo, un procesamiento se da por perdido y se puede volver a intentar. */
export const MINUTOS_PROCESO_VENCIDO = 15

const COLUMNAS = `id, negocio, email, estado, version, procesando_desde, ultimo_error, entrada_pendiente, aviso_enviado_en`

interface Fila {
  id: string
  negocio: string
  email: string
  estado: EstadoCuestionario
  version: number
  procesando_desde: Date | string | null
  ultimo_error: string | null
  entrada_pendiente: Entrada | null
  aviso_enviado_en: Date | string | null
}

function fecha(valor: Date | string | null): Date | null {
  return valor === null ? null : valor instanceof Date ? valor : new Date(valor)
}

function desdeFila(fila: Fila): Cuestionario {
  return {
    id: fila.id,
    negocio: fila.negocio,
    email: fila.email,
    estado: fila.estado,
    version: fila.version,
    procesandoDesde: fecha(fila.procesando_desde),
    ultimoError: fila.ultimo_error,
    entradaPendiente: fila.entrada_pendiente,
    avisoEnviadoEn: fecha(fila.aviso_enviado_en),
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

export async function crearCuestionario(negocio: string, email: string): Promise<{ cuestionario: Cuestionario; token: string }> {
  const nombre = negocio.trim()
  const correo = email.trim()
  if (!nombre) throw new ErrorCuestionario('Falta el nombre del negocio.', 400)
  if (nombre.length > 200) throw new ErrorCuestionario('El nombre del negocio es demasiado largo.', 400)
  // Solo lo que el servidor de correo puede usar: un mail con acentos se aceptaría acá y después
  // no se le podría mandar el link.
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(correo)) {
    throw new ErrorCuestionario('El mail no tiene un formato válido. Revisá que no tenga espacios ni acentos.', 400)
  }

  // 24 bytes al azar: imposible de adivinar, y en base64url entra entero en un link.
  const token = randomBytes(24).toString('base64url')
  const estado = estadoInicial(nombre)
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    `INSERT INTO cuestionarios (id, negocio, email, etapa, estado, token_sha256)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING ${COLUMNAS}`,
    [nuevoId(), nombre, correo, estado.etapa, JSON.stringify(estado), hashDe(token)],
  )
  return { cuestionario: desdeFila(rows[0]), token }
}

export async function buscarPorToken(token: string): Promise<Cuestionario | null> {
  if (!token) return null
  const base = await db()
  const { rows } = await base.consulta<Fila>(`SELECT ${COLUMNAS} FROM cuestionarios WHERE token_sha256 = $1`, [hashDe(token)])
  return rows[0] ? desdeFila(rows[0]) : null
}

export async function buscarPorId(id: string): Promise<Cuestionario | null> {
  const base = await db()
  const { rows } = await base.consulta<Fila>(`SELECT ${COLUMNAS} FROM cuestionarios WHERE id = $1`, [id])
  return rows[0] ? desdeFila(rows[0]) : null
}

/** Está procesando una entrada y todavía no se venció. */
export function estaProcesando(cuestionario: Cuestionario): boolean {
  return (
    cuestionario.procesandoDesde !== null &&
    Date.now() - cuestionario.procesandoDesde.getTime() < MINUTOS_PROCESO_VENCIDO * 60_000
  )
}

/**
 * Guarda un estado nuevo solo si nadie lo cambió desde que se leyó y no se está procesando.
 *
 * Si el cliente tiene el cuestionario abierto en dos pestañas y manda desde las dos, la
 * segunda escritura pierde en vez de pisar respuestas que no vio.
 */
export async function guardarEstado(cuestionario: Cuestionario, estado: EstadoCuestionario): Promise<Cuestionario> {
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    `UPDATE cuestionarios
        SET estado = $1::jsonb, etapa = $2, version = version + 1, actualizado_en = now()
      WHERE id = $3 AND version = $4
        AND (procesando_desde IS NULL OR procesando_desde < now() - make_interval(mins => $5))
      RETURNING ${COLUMNAS}`,
    [JSON.stringify(estado), estado.etapa, cuestionario.id, cuestionario.version, MINUTOS_PROCESO_VENCIDO],
  )
  if (!rows[0]) {
    throw new ErrorCuestionario('El cuestionario cambió en otra pestaña o dispositivo. Recargá la página para seguir desde donde quedó.', 409)
  }
  return desdeFila(rows[0])
}

/**
 * Pone el cuestionario a procesar una entrada. Es el candado: si ya hay otra en curso o la
 * versión no coincide, no se toma.
 */
export async function tomarParaProcesar(cuestionario: Cuestionario, entrada: Entrada): Promise<Cuestionario> {
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    `UPDATE cuestionarios
        SET procesando_desde = now(), ultimo_error = NULL, entrada_pendiente = $1::jsonb
      WHERE id = $2 AND version = $3
        AND (procesando_desde IS NULL OR procesando_desde < now() - make_interval(mins => $4))
      RETURNING ${COLUMNAS}`,
    [JSON.stringify(entrada), cuestionario.id, cuestionario.version, MINUTOS_PROCESO_VENCIDO],
  )
  if (!rows[0]) {
    throw new ErrorCuestionario('Tu respuesta anterior se está procesando o la página quedó desactualizada. Recargá para seguir.', 409)
  }
  return desdeFila(rows[0])
}

/** Guarda el resultado de un procesamiento y libera el candado. */
export async function terminarProceso(cuestionario: Cuestionario, estado: EstadoCuestionario): Promise<Cuestionario> {
  const base = await db()
  const { rows } = await base.consulta<Fila>(
    `UPDATE cuestionarios
        SET estado = $1::jsonb, etapa = $2, version = version + 1, actualizado_en = now(),
            procesando_desde = NULL, ultimo_error = NULL, entrada_pendiente = NULL,
            terminado_en = CASE WHEN $2 = 'terminado' THEN now() ELSE terminado_en END
      WHERE id = $3 AND version = $4
      RETURNING ${COLUMNAS}`,
    [JSON.stringify(estado), estado.etapa, cuestionario.id, cuestionario.version],
  )
  if (!rows[0]) throw new Error(`El cuestionario ${cuestionario.id} cambió mientras se procesaba: no se guardó el resultado.`)
  return desdeFila(rows[0])
}

/** Libera el candado y deja el error a la vista, con la entrada pendiente para reintentar. */
export async function fallarProceso(id: string, mensaje: string): Promise<void> {
  const base = await db()
  await base.consulta('UPDATE cuestionarios SET procesando_desde = NULL, ultimo_error = $2 WHERE id = $1', [id, mensaje])
}

export async function contarCreadosDesde(desde: Date): Promise<number> {
  const base = await db()
  const { rows } = await base.consulta<{ n: number }>('SELECT count(*)::int AS n FROM cuestionarios WHERE creado_en >= $1', [desde])
  return rows[0].n
}

export async function contarLlamadas(cuestionarioId: string): Promise<number> {
  const base = await db()
  const { rows } = await base.consulta<{ n: number }>('SELECT count(*)::int AS n FROM llamadas_ia WHERE cuestionario_id = $1', [
    cuestionarioId,
  ])
  return rows[0].n
}

export async function consumoDe(cuestionarioId: string): Promise<ConsumoLlamada[]> {
  const base = await db()
  const { rows } = await base.consulta<{
    modelo: string
    cache: VidaCache | null
    tokens_entrada: number
    tokens_salida: number
    tokens_cache_escritos: number
    tokens_cache_leidos: number
  }>(
    `SELECT modelo, cache, tokens_entrada, tokens_salida, tokens_cache_escritos, tokens_cache_leidos
       FROM llamadas_ia WHERE cuestionario_id = $1`,
    [cuestionarioId],
  )
  return rows.map((r) => ({
    modelo: r.modelo,
    cache: r.cache,
    tokensEntrada: r.tokens_entrada,
    tokensSalida: r.tokens_salida,
    tokensCacheEscritos: r.tokens_cache_escritos,
    tokensCacheLeidos: r.tokens_cache_leidos,
  }))
}

/** Terminados cuyo aviso no salió y todavía tienen reintentos. */
export async function avisosPendientes(maximoIntentos: number): Promise<string[]> {
  const base = await db()
  const { rows } = await base.consulta<{ id: string }>(
    `SELECT id FROM cuestionarios
      WHERE etapa = 'terminado' AND aviso_enviado_en IS NULL AND aviso_intentos < $1
      ORDER BY terminado_en`,
    [maximoIntentos],
  )
  return rows.map((r) => r.id)
}

export async function marcarAviso(id: string, error: string | null): Promise<void> {
  const base = await db()
  if (error === null) {
    await base.consulta('UPDATE cuestionarios SET aviso_enviado_en = now(), aviso_error = NULL WHERE id = $1', [id])
  } else {
    await base.consulta('UPDATE cuestionarios SET aviso_intentos = aviso_intentos + 1, aviso_error = $2 WHERE id = $1', [id, error])
  }
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
                                  tokens_cache_escritos, tokens_cache_leidos, cache, duracion_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          cuestionarioId,
          r.paso,
          r.modelo,
          r.stopReason,
          r.tokensEntrada,
          r.tokensSalida,
          r.tokensCacheEscritos,
          r.tokensCacheLeidos,
          r.cache,
          r.duracionMs,
          r.error,
        ],
      )
    } catch (err) {
      console.error('[llamadas_ia] no se pudo registrar la llamada:', err)
    }
  }
}
