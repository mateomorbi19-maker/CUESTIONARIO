import Cuestionario from './Cuestionario'

/**
 * Solo pasa el token. El estado se pide desde el navegador: la espera, los reintentos y los
 * borradores viven en un único lugar (Cuestionario.tsx).
 */
export default async function PaginaCuestionario({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // La key reinicia todo si se pasa de un cuestionario a otro sin recargar la página.
  return <Cuestionario key={token} token={token} />
}
