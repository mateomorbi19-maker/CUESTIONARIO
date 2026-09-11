import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Las skills de la clase 1 del starter kit y la plantilla de CLAUDE.md que completa la entrevista.
 *
 * Están copiadas tal cual en skills/ y son la fuente de verdad del método: la app no las
 * reescribe. Lo que cambia por ser web va en una capa aparte.
 */
export const SKILLS = ['mi-negocio', 'entrevista'] as const
export type NombreSkill = (typeof SKILLS)[number]

// En la imagen de Docker el Dockerfile copia skills/ al lado de server.js y el proceso arranca
// parado en /app, así que process.cwd() sirve igual en local y en producción. Por eso las
// lecturas llevan turbopackIgnore: sin eso el build mete el proyecto entero en la imagen.
const RUTAS = {
  'mi-negocio': join('skills', 'mi-negocio', 'SKILL.md'),
  entrevista: join('skills', 'entrevista', 'SKILL.md'),
  plantilla: join('skills', 'starter-kit', 'CLAUDE.md'),
} as const

type Recurso = keyof typeof RUTAS

const cache = new Map<Recurso, Promise<string>>()

function leer(recurso: Recurso): Promise<string> {
  let texto = cache.get(recurso)
  if (!texto) {
    texto = readFile(join(/*turbopackIgnore: true*/ process.cwd(), RUTAS[recurso]), 'utf8').catch((err) => {
      cache.delete(recurso)
      throw new Error(
        `No se encontró ${RUTAS[recurso]}. Si esto pasa en Easypanel, la imagen se construyó sin la carpeta skills: revisá el Dockerfile y el .dockerignore.`,
        { cause: err },
      )
    })
    cache.set(recurso, texto)
  }
  return texto
}

export function leerSkill(nombre: NombreSkill): Promise<string> {
  return leer(nombre)
}

/** La plantilla de CLAUDE.md del starter kit, con los [PENDIENTE] que completa la entrevista. */
export function leerPlantillaClaude(): Promise<string> {
  return leer('plantilla')
}

/** ¿Están las skills y la plantilla en el disco y con contenido? */
export async function estadoSkills(): Promise<{ ok: boolean; detalle: string; faltan: string[] }> {
  const faltan: string[] = []
  for (const recurso of Object.keys(RUTAS) as Recurso[]) {
    try {
      const info = await stat(join(/*turbopackIgnore: true*/ process.cwd(), RUTAS[recurso]))
      if (info.size === 0) faltan.push(RUTAS[recurso])
    } catch {
      faltan.push(RUTAS[recurso])
    }
  }
  return {
    ok: faltan.length === 0,
    detalle:
      faltan.length === 0
        ? 'Skills y plantilla presentes.'
        : `Faltan en el disco: ${faltan.join(', ')}. La imagen se construyó sin la carpeta skills o algún archivo quedó vacío.`,
    faltan,
  }
}
