import type { PantallaDe } from '../componentes/Contexto'
import { IconoCheck } from '../componentes/Iconos'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** El final. El cliente no ve el resultado del trabajo: solo el agradecimiento. */
export function Gracias({ pantalla }: { pantalla: PantallaDe<'gracias'> }) {
  return (
    <section className="gracias">
      <span className="gracias-marca" aria-hidden="true">
        <IconoCheck width={28} height={28} />
      </span>
      <h1 className="solo-lectores" tabIndex={-1}>
        Cuestionario terminado
      </h1>
      <div className="gracias-texto">
        <TextoConNegritas texto={pantalla.texto} />
      </div>
    </section>
  )
}
