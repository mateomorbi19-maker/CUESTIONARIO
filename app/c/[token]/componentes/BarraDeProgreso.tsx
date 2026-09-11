import type { ReactNode } from 'react'

interface Props {
  porcentaje: number
  texto: string
  /** Lo que va a la derecha del texto, en la misma línea (el «Guardado»). */
  accesorio?: ReactNode
}

export function BarraDeProgreso({ porcentaje, texto, accesorio }: Props) {
  // Acotado por las dudas: un número raro del servidor no puede desbordar la barra.
  const valor = Number.isFinite(porcentaje) ? Math.min(100, Math.max(0, Math.round(porcentaje))) : 0

  return (
    <div className="progreso">
      <div className="progreso-fila">
        <p className="progreso-texto">{texto}</p>
        {accesorio}
      </div>
      <div
        className="progreso-barra"
        role="progressbar"
        aria-label="Avance del cuestionario"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valor}
        aria-valuetext={`${texto}: ${valor} %`}
      >
        <div className="progreso-relleno" style={{ width: `${valor}%` }} />
      </div>
    </div>
  )
}
