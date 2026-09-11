import { InicioCuestionario } from './componentes/InicioCuestionario'

/**
 * El mini inicio de un cuestionario, a donde lleva el link personal: el avance y un botón para
 * entrar a las preguntas (/preguntas). El estado se pide desde el navegador, como en el resto.
 */
export default async function PaginaCuestionario({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return (
    <div className="pagina pagina-inicio">
      <main className="hoja inicio">
        {/* La key reinicia todo si se pasa de un cuestionario a otro sin recargar la página. */}
        <InicioCuestionario key={token} token={token} />
      </main>
    </div>
  )
}
