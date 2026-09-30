import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bundle autocontenido: la imagen de Docker queda chica y arranca rápido.
  output: 'standalone',
  // Fija la raíz del proyecto. Sin esto, un package-lock.json suelto en alguna carpeta de
  // arriba hace que el empaquetador tome otra raíz y arme mal el standalone.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // El transcriptor se lanza como proceso aparte y la imagen lo copia entero, con sus modelos,
  // en su propia etapa del Dockerfile. Si el rastreo de Next lo siguiera por la ruta que arma
  // lib/multimedia.ts, metería en el standalone cientos de MB de onnxruntime, los modelos o los
  // archivos de los clientes que haya en data/.
  // Esto cubre lo que rastrean las rutas. Lo que se rastrea desde instrumentation.ts no pasa por
  // esta opción (Next 16.3): ahí el freno es el /*turbopackIgnore: true*/ de cada
  // join(process.cwd(), …), como en lib/skills.ts.
  outputFileTracingExcludes: {
    '*': ['./transcriptor/**', './data/**', './modelos/**'],
  },
  // PGlite trae su propio WebAssembly y solo se carga en desarrollo: si el empaquetador lo
  // procesa, pierde la ruta a sus archivos y no arranca.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Sin esto, `next dev` le agrega un bloque propio a AGENTS.md cada vez que arranca con un
  // agente de código abierto. Ese archivo lo escribimos a mano y no lo toca nadie más.
  agentRules: false,
}

export default nextConfig
