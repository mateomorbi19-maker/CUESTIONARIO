import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bundle autocontenido: la imagen de Docker queda chica y arranca rápido.
  output: 'standalone',
  // Fija la raíz del proyecto. Sin esto, un package-lock.json suelto en alguna carpeta de
  // arriba hace que el empaquetador tome otra raíz y arme mal el standalone.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // PGlite trae su propio WebAssembly y solo se carga en desarrollo: si el empaquetador lo
  // procesa, pierde la ruta a sus archivos y no arranca.
  serverExternalPackages: ['@electric-sql/pglite'],
}

export default nextConfig
