import { TextoConNegritas } from './TextoConNegritas'

/** Error junto al formulario. Se monta ya con el mensaje: role="alert" se anuncia al aparecer. */
export function MensajeError({ mensaje }: { mensaje: string | null }) {
  if (!mensaje) return null
  return (
    <div className="mensaje-error" role="alert">
      <TextoConNegritas texto={mensaje} />
    </div>
  )
}

/** Algo que hay que leer antes de seguir: lo que falta del material, un paso que no terminó. */
export function Aviso({ texto }: { texto: string }) {
  return (
    <div className="aviso">
      <TextoConNegritas texto={texto} />
    </div>
  )
}
