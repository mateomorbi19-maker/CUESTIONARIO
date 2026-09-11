import { useId } from 'react'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { IconoFlecha } from '../componentes/Iconos'
import { MensajeError } from '../componentes/Mensajes'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** El negocio tiene dos procesos y elige con cuál arrancar. Tocar una opción ya la manda. */
export function Eleccion({ pantalla }: { pantalla: PantallaDe<'eleccion'> }) {
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const id = useId()
  const idPregunta = `${id}pregunta`

  return (
    <section className="pantalla">
      <h1 className="pregunta" id={idPregunta} tabIndex={-1}>
        <TextoConNegritas texto={pantalla.texto} enLinea />
      </h1>
      <div className="opciones" role="group" aria-labelledby={idPregunta}>
        {pantalla.opciones.map((opcion, i) => {
          const guardando = enCurso === `opcion-${i}`
          return (
            <button
              key={i}
              type="button"
              className="opcion"
              onClick={() => mandar(`opcion-${i}`, { tipo: 'eleccion', opcion })}
              disabled={ocupado}
              aria-busy={guardando || undefined}
            >
              <span>{opcion}</span>
              <span className="opcion-marca">{guardando ? 'Guardando…' : <IconoFlecha />}</span>
            </button>
          )
        })}
      </div>
      <MensajeError mensaje={error} />
    </section>
  )
}
