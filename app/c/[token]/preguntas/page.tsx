import Cuestionario from '../Cuestionario'

/**
 * Las preguntas. Solo pasa el token: el estado se pide desde el navegador, así la espera, los
 * reintentos y los borradores viven en un único lugar (Cuestionario.tsx).
 */
export default async function PaginaPreguntas({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // La key reinicia todo si se pasa de un cuestionario a otro sin recargar la página.
  return <Cuestionario key={token} token={token} />
}
