import { useEffect, useState } from 'react'

// La espera normal es de uno o dos minutos. Pasado esto conviene decir que no se pierde nada.
const DEMORA_LARGA_MS = 150_000

interface Props {
  mensaje: string | null
  /** Falló la última consulta del estado: se sigue intentando solo. */
  sinConexion?: boolean
}

/** Mientras el servidor procesa lo último que se mandó. */
export function Espera({ mensaje, sinConexion = false }: Props) {
  const [demorada, setDemorada] = useState(false)

  useEffect(() => {
    const temporizador = window.setTimeout(() => setDemorada(true), DEMORA_LARGA_MS)
    return () => window.clearTimeout(temporizador)
  }, [])

  let extra: string | null = null
  if (sinConexion) extra = 'Se cortó la conexión. Seguimos intentando…'
  else if (demorada) {
    extra =
      'Está tardando más de lo normal. Podés dejar esta página abierta o volver más tarde con el mismo link: no se pierde nada.'
  }

  return (
    <section className="espera">
      {/* Una hoja que se va escribiendo: dice «trabajando» sin parecer una charla. */}
      <div className="espera-hoja" aria-hidden="true">
        <span className="espera-linea" />
        <span className="espera-linea" />
        <span className="espera-linea" />
        <span className="espera-linea" />
      </div>
      <div role="status">
        <h1 className="espera-mensaje" tabIndex={-1}>
          {mensaje || 'Un momento, estamos guardando lo que mandaste.'}
        </h1>
      </div>
      <p className="espera-nota">
        Esto puede tardar hasta un par de minutos. Podés dejar la página abierta.
      </p>
      <p className="espera-extra" aria-live="polite">
        {extra}
      </p>
    </section>
  )
}

/** Versión chica, dentro de la pantalla, para cambios que no justifican taparla. */
export function EsperaEnLinea({ mensaje }: { mensaje: string }) {
  return (
    <p className="espera-en-linea" role="status">
      <span className="girando" aria-hidden="true" />
      {mensaje}
    </p>
  )
}
