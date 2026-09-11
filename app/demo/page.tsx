import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Galeria from './Galeria'

export const metadata: Metadata = {
  title: 'Galería de pantallas',
}

/**
 * Todas las pantallas con datos inventados, para revisarlas sin servidor. `?v=<id>` muestra una
 * sola, como se vería de verdad.
 */
export default async function PaginaDemo({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Es una herramienta de desarrollo con datos de ejemplo: en producción no existe.
  if (process.env.NODE_ENV === 'production') notFound()
  const { v } = await searchParams
  return <Galeria sola={typeof v === 'string' ? v : null} />
}
