import { useEffect, useState, type ReactNode } from 'react'
import { BarraDeProgreso } from './BarraDeProgreso'
import { IconoCheck } from './Iconos'

// Lo justo para leerlo de reojo sin que quede como algo pendiente de mirar.
const DURACION_GUARDADO_MS = 3200

interface Props {
  progreso: { porcentaje: number; texto: string } | null
  /** Cambia cada vez que algo se guarda bien: muestra un «Guardado» que se va solo. */
  marcaGuardado?: number
  /** Aviso arriba de todo, como «Se actualizó desde otra pestaña». */
  aviso?: string | null
  /** Contenido centrado en el alto de la pantalla (el agradecimiento). */
  centrado?: boolean
  /** En la galería de /demo van muchas juntas: sin alto de pantalla completa ni <main>. */
  compacto?: boolean
  children: ReactNode
}

/** Lo que rodea a cada pantalla: el avance arriba y la hoja con el contenido. */
export function Marco({
  progreso,
  marcaGuardado = 0,
  aviso = null,
  centrado = false,
  compacto = false,
  children,
}: Props) {
  const [guardadoVisible, setGuardadoVisible] = useState(false)

  useEffect(() => {
    if (!marcaGuardado) return
    setGuardadoVisible(true)
    const temporizador = window.setTimeout(() => setGuardadoVisible(false), DURACION_GUARDADO_MS)
    return () => window.clearTimeout(temporizador)
  }, [marcaGuardado])

  const Hoja = compacto ? 'div' : 'main'
  const clases = ['pagina', centrado && 'pagina-centrada', compacto && 'pagina-compacta']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={clases}>
      {progreso && (
        <header className="cabecera">
          <BarraDeProgreso
            porcentaje={progreso.porcentaje}
            texto={progreso.texto}
            accesorio={
              // La región está siempre: los lectores de pantalla anuncian cuando cambia lo de adentro.
              <p className="guardado" aria-live="polite">
                {guardadoVisible && (
                  <span key={marcaGuardado} className="guardado-marca">
                    <IconoCheck width={16} height={16} />
                    Guardado
                  </span>
                )}
              </p>
            }
          />
        </header>
      )}
      <Hoja className="hoja">
        {aviso && (
          <p className="aviso aviso-arriba" role="status">
            {aviso}
          </p>
        )}
        {children}
      </Hoja>
    </div>
  )
}
