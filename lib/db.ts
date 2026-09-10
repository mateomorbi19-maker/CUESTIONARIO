import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'

/**
 * Acceso a la base.
 *
 * En Easypanel siempre hay DATABASE_URL y se habla con Postgres por `pg`. En la compu de
 * desarrollo no hay Docker: sin DATABASE_URL, y fuera de producción, se levanta PGlite,
 * que es Postgres compilado a WebAssembly corriendo dentro del mismo proceso de Node. Es
 * el mismo motor y el mismo SQL, así que lo que anda en local anda en el servidor.
 *
 * El resto de la app usa esta interfaz y nunca `pg` ni PGlite directo.
 */
export interface Base {
  motor: 'postgres' | 'pglite'
  consulta<T>(sql: string, parametros?: unknown[]): Promise<{ rows: T[] }>
  transaccion<R>(fn: (tx: Consultor) => Promise<R>): Promise<R>
  /** Varias sentencias juntas y sin parámetros. Solo para aplicar el esquema. */
  ejecutarScript(sql: string): Promise<void>
}

export type Consultor = Pick<Base, 'consulta'>

/**
 * Next.js recarga los módulos en caliente en desarrollo: sin cachear en globalThis se
 * abriría una conexión nueva en cada recarga, y con PGlite dos instancias sobre la misma
 * carpeta corrompen los datos.
 */
const globalParaBase = globalThis as unknown as {
  _base?: Promise<Base>
  _esquemaListo?: Promise<void>
  /** Si alguna vez se conectó, un 28P01 posterior NO es la contraseña. Ver traducirErrorBase. */
  _conectoAlgunaVez?: boolean
}

/**
 * Error de configuración o de conexión a la base.
 *
 * Se distingue de un fallo cualquiera para poder decir qué hay que arreglar. El mensaje
 * no expone credenciales: solo dice qué falta.
 */
export class ErrorBaseDeDatos extends Error {
  constructor(
    message: string,
    readonly causa: 'sin_configurar' | 'inalcanzable' | 'autenticacion' | 'desconocida' = 'desconocida',
  ) {
    super(message)
    this.name = 'ErrorBaseDeDatos'
  }
}

/** Traduce los códigos de error de red y de Postgres a algo accionable. */
export function traducirErrorBase(err: unknown): ErrorBaseDeDatos | null {
  if (err instanceof ErrorBaseDeDatos) return err
  const codigo = (err as { code?: string })?.code
  switch (codigo) {
    case 'ECONNREFUSED':
      return new ErrorBaseDeDatos(
        'No hay ningún Postgres escuchando en la dirección de DATABASE_URL. Verificá que el servicio de la base esté levantado en Easypanel y que el host y el puerto sean los de su URL interna.',
        'inalcanzable',
      )
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ErrorBaseDeDatos(
        'No se pudo resolver el host de DATABASE_URL. Revisá que el nombre del servicio de Postgres esté bien escrito.',
        'inalcanzable',
      )
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return new ErrorBaseDeDatos(
        'La conexión con la base se cortó por tiempo de espera. Si la base está fuera de Easypanel, puede faltar TLS: probá con DATABASE_SSL=true.',
        'inalcanzable',
      )
    case '28P01':
    case '28000':
      // Si ya se conectó con esta misma cadena, la contraseña no puede estar mal: casi
      // siempre es el límite de conexiones. Acusar a la contraseña manda a resetearla,
      // que no arregla nada.
      if (globalParaBase._conectoAlgunaVez) {
        return new ErrorBaseDeDatos(
          'La base rechazó una conexión nueva, pero la app ya venía conectada con esta misma cadena: no es la contraseña. Casi siempre es el límite de conexiones simultáneas. Esperá unos segundos y reintentá.',
          'inalcanzable',
        )
      }
      return new ErrorBaseDeDatos(
        'Usuario o contraseña incorrectos en DATABASE_URL. La causa más frecuente es una contraseña con caracteres que la URL se come si no van codificados (#, ?, / y @). El log del servidor dice a qué usuario y host se intentó conectar.',
        'autenticacion',
      )
    case '3D000':
      return new ErrorBaseDeDatos('La base indicada en DATABASE_URL no existe.', 'sin_configurar')
    default:
      return null
  }
}

/**
 * A qué usuario y host apunta DATABASE_URL, sin la contraseña.
 *
 * Va únicamente al log del servidor: /api/salud es pública, y ahí le estaría diciendo a
 * cualquiera dónde vive la base y con qué usuario entrar.
 */
export function destinoBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) return 'sin DATABASE_URL'

  const inicio = url.indexOf('://')
  const fin = url.lastIndexOf('@')
  if (inicio < 0 || fin < inicio) return 'DATABASE_URL ilegible: no tiene la forma postgres://usuario:clave@host:puerto/base'

  const credenciales = url.slice(inicio + 3, fin)
  const usuario = credenciales.split(':')[0]
  const clave = credenciales.slice(usuario.length + 1)
  const sinCodificar = [...new Set(clave.match(/[#?/@]/g) ?? [])]

  const aviso = sinCodificar.length
    ? `  <-- la contraseña contiene ${sinCodificar.map((c) => `"${c}"`).join(' y ')} sin codificar: la URL se corta ahí y la clave llega incompleta`
    : ''
  return `${usuario}@${url.slice(fin + 1)}${aviso}`
}

function basePostgres(connectionString: string): Base {
  const pool = new Pool({
    connectionString,
    // Easypanel expone Postgres dentro de la red interna sin TLS.
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 10,
  })

  return {
    motor: 'postgres',
    async consulta<T>(sql: string, parametros?: unknown[]) {
      const r = await pool.query(sql, parametros)
      return { rows: r.rows as T[] }
    },
    async transaccion<R>(fn: (tx: Consultor) => Promise<R>) {
      const cliente = await pool.connect()
      try {
        await cliente.query('BEGIN')
        const resultado = await fn({
          async consulta<T>(sql: string, parametros?: unknown[]) {
            const r = await cliente.query(sql, parametros)
            return { rows: r.rows as T[] }
          },
        })
        await cliente.query('COMMIT')
        return resultado
      } catch (err) {
        // Si el ROLLBACK también falla, el error que importa es el original.
        await cliente.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        cliente.release()
      }
    },
    async ejecutarScript(sql: string) {
      await pool.query(sql)
    },
  }
}

async function basePglite(): Promise<Base> {
  const { PGlite } = await import('@electric-sql/pglite')
  const carpeta = join(process.env.DIR_DATOS ?? join(process.cwd(), 'data'), 'pglite')
  mkdirSync(carpeta, { recursive: true })
  const pglite = await PGlite.create(carpeta)

  return {
    motor: 'pglite',
    async consulta<T>(sql: string, parametros?: unknown[]) {
      const r = await pglite.query<T>(sql, parametros)
      return { rows: r.rows }
    },
    async transaccion<R>(fn: (tx: Consultor) => Promise<R>) {
      return pglite.transaction(async (tx) =>
        fn({
          async consulta<T>(sql: string, parametros?: unknown[]) {
            const r = await tx.query<T>(sql, parametros)
            return { rows: r.rows }
          },
        }),
      )
    },
    async ejecutarScript(sql: string) {
      await pglite.exec(sql)
    },
  }
}

function crearBase(): Promise<Base> {
  const url = process.env.DATABASE_URL
  if (url) return Promise.resolve(basePostgres(url))

  // En producción una base embebida perdería todo en cada deploy: mejor no arrancar.
  if (process.env.NODE_ENV === 'production') {
    return Promise.reject(
      new ErrorBaseDeDatos(
        'Falta la variable DATABASE_URL: no hay ninguna base configurada. En Easypanel, creá el servicio de Postgres y cargá su URL interna en las variables de la app.',
        'sin_configurar',
      ),
    )
  }
  return basePglite()
}

function base(): Promise<Base> {
  if (!globalParaBase._base) {
    globalParaBase._base = crearBase().catch((err) => {
      // Sin esto, un fallo al arrancar quedaría cacheado y la base no volvería nunca.
      globalParaBase._base = undefined
      throw err
    })
  }
  return globalParaBase._base
}

/*
 * El esquema completo vive acá y se aplica de forma idempotente al primer uso. No hay
 * carpeta de migraciones: los cambios se agregan con IF NOT EXISTS.
 */
const SCHEMA = `
-- Un cuestionario por negocio. Crece en la fase 1 con ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS cuestionarios (
  id             TEXT PRIMARY KEY,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  negocio        TEXT NOT NULL,
  email          TEXT NOT NULL,
  etapa          TEXT NOT NULL DEFAULT 'triage'
);
`

/**
 * Las tablas que el esquema tiene que haber creado.
 *
 * Es una lista y no un número: con un total, agregar una tabla obliga a acordarse de subir
 * el contador, y si alguien no lo hace /api/salud informa "esquema creado" aunque la tabla
 * nueva haya fallado.
 */
export const TABLAS = ['cuestionarios'] as const

function asegurarEsquema(b: Base): Promise<void> {
  if (!globalParaBase._esquemaListo) {
    globalParaBase._esquemaListo = b.ejecutarScript(SCHEMA).catch((err) => {
      // Si falla, se reintenta en la próxima request.
      globalParaBase._esquemaListo = undefined
      throw err
    })
  }
  return globalParaBase._esquemaListo
}

export async function db(): Promise<Base> {
  try {
    const b = await base()
    await asegurarEsquema(b)
    globalParaBase._conectoAlgunaVez = true
    return b
  } catch (err) {
    throw traducirErrorBase(err) ?? err
  }
}

/** ¿Está la base configurada, alcanzable y con el esquema creado? */
export async function estadoBase(): Promise<{
  ok: boolean
  detalle: string
  motor?: Base['motor']
  causa?: string
  version?: string
  faltan?: string[]
}> {
  try {
    const b = await db()
    const version = await b.consulta<{ v: string }>('SELECT version() AS v')
    // Se filtra en JS y no con un parámetro de tipo array: así la misma consulta anda
    // igual en pg y en PGlite, que serializan los arrays distinto.
    const presentes = await b.consulta<{ tabla: string }>(
      `SELECT table_name::text AS tabla FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const hay = new Set(presentes.rows.map((r) => r.tabla))
    const faltan = TABLAS.filter((t) => !hay.has(t))
    return {
      ok: faltan.length === 0,
      detalle:
        faltan.length === 0
          ? 'Base conectada y esquema creado.'
          : `La base responde pero le faltan tablas: ${faltan.join(', ')}. Reiniciá el servicio para que el esquema se vuelva a aplicar y mirá el log del arranque.`,
      motor: b.motor,
      causa: faltan.length === 0 ? undefined : 'sin_configurar',
      version: version.rows[0]?.v?.split(',')[0] ?? 'desconocida',
      faltan,
    }
  } catch (err) {
    const traducido = traducirErrorBase(err)
    if (traducido) {
      if (traducido.causa === 'autenticacion') {
        console.error('[salud] la base rechazó las credenciales. Se intentó conectar como:', destinoBase())
      }
      return { ok: false, detalle: traducido.message, causa: traducido.causa }
    }
    return { ok: false, detalle: err instanceof Error ? err.message : 'Error desconocido.', causa: 'desconocida' }
  }
}
