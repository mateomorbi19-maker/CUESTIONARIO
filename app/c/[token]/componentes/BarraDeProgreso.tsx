interface Props {
  porcentaje: number
  texto: string
}

export function BarraDeProgreso({ porcentaje, texto }: Props) {
  // Acotado por las dudas: un número raro del servidor no puede desbordar la barra.
  const valor = Number.isFinite(porcentaje) ? Math.min(100, Math.max(0, Math.round(porcentaje))) : 0

  return (
    <div className="progreso">
      <div className="progreso-fila">
        <p className="progreso-texto">{texto}</p>
        <p className="progreso-porcentaje" aria-hidden="true">
          {valor} %
        </p>
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
