import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Las skills de la clase 1 del starter kit.
 *
 * Están copiadas tal cual en skills/ y son la fuente de verdad del método: la app no las
 * reescribe. Lo que cambia por ser web (no hay archivos ni comandos) va en una capa aparte.
 */
export const SKILLS = ['mi-negocio', 'entrevista'] as const
export type NombreSkill = (typeof SKILLS)[number]

function ruta(nombre: NombreSkill): string {
  // En la imagen de Docker el Dockerfile copia skills/ al lado de server.js y el proceso
  // arranca parado en /app, así que process.cwd() sirve igual en local y en producción.
  return join(process.cwd(), 'skills', nombre, 'SKILL.md')
}

const cache = new Map<NombreSkill, Promise<string>>()

export function leerSkill(nombre: NombreSkill): Promise<string> {
  let texto = cache.get(nombre)
  if (!texto) {
    texto = readFile(ruta(nombre), 'utf8').catch((err) => {
      cache.delete(nombre)
      throw new Error(
        `No se encontró skills/${nombre}/SKILL.md. Si esto pasa en Easypanel, la imagen se construyó sin la carpeta skills: revisá el Dockerfile y el .dockerignore.`,
        { cause: err },
      )
    })
    cache.set(nombre, texto)
  }
  return texto
}

/** ¿Están todas las skills en el disco y con contenido? */
export async function estadoSkills(): Promise<{ ok: boolean; detalle: string; faltan: string[] }> {
  const faltan: string[] = []
  for (const nombre of SKILLS) {
    try {
      const info = await stat(ruta(nombre))
      if (info.size === 0) faltan.push(nombre)
    } catch {
      faltan.push(nombre)
    }
  }
  return {
    ok: faltan.length === 0,
    detalle:
      faltan.length === 0
        ? 'Skills presentes.'
        : `Faltan skills en el disco: ${faltan.join(', ')}. La imagen se construyó sin la carpeta skills o alguna quedó vacía.`,
    faltan,
  }
}
