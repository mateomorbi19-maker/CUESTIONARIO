import { useEffect, useRef, useState } from 'react'
import { sanearGrupo } from '@/lib/grupos'
import { Boton } from './Boton'
import { useSubidas } from './SubidaDeArchivos'

interface Props {
  id: string
  /**
   * Archivos ya elegidos que parecen de un chat de WhatsApp y falta saber de cuál. Vacío: primero
   * se le pone nombre y después se eligen.
   */
  archivos: File[]
  onCerrar: () => void
}

function mismoNombre(a: string, b: string): boolean {
  return a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es')
}

/**
 * Armar una conversación a mano: un nombre y sus archivos. Es el camino del celular cuando
 * WhatsApp no deja un .zip sino archivos sueltos: con el nombre quedan juntos y no se mezclan con
 * los de otro chat.
 */
export function NuevaConversacion({ id, archivos, onCerrar }: Props) {
  const { encolar, gruposEnUso } = useSubidas()
  const [nombre, setNombre] = useState('')
  const [error, setError] = useState<string | null>(null)
  const campo = useRef<HTMLInputElement>(null)
  const selector = useRef<HTMLInputElement>(null)
  const yaElegidos = archivos.length > 0
  const idTitulo = `${id}-titulo`
  const idNombre = `${id}-nombre`
  const idAyuda = `${id}-ayuda`
  const idError = `${id}-error`

  useEffect(() => {
    // Se abre por un botón: el cursor va al nombre, que es lo primero que hay que completar.
    campo.current?.focus()
  }, [])

  function avisar(mensaje: string): null {
    setError(mensaje)
    campo.current?.focus()
    return null
  }

  function grupoValido(): string | null {
    const grupo = sanearGrupo(nombre)
    if (!grupo) return avisar('Ponele un nombre para no mezclarla con las otras.')
    if (gruposEnUso().some((usado) => mismoNombre(usado, grupo))) {
      // Sumarlos a la que ya existe podría juntar a dos clientes distintos: que lo decida ella.
      return avisar(
        'Ya hay una con ese nombre. Si es la misma, usá «Agregar» en su tarjeta; si es otra, ponele otro nombre.',
      )
    }
    return grupo
  }

  function subir(elegidos: File[]) {
    const grupo = grupoValido()
    if (!grupo) return
    encolar(elegidos.map((archivo) => ({ archivo, grupo, grupoElegido: true, esChat: false })))
    onCerrar()
  }

  function seguir() {
    if (yaElegidos) subir(archivos)
    // El nombre se controla antes de abrir el selector: elegir veinte archivos para después
    // enterarse de que faltaba el nombre obligaría a elegirlos de nuevo.
    else if (grupoValido()) selector.current?.click()
  }

  function subirSueltos() {
    encolar(archivos.map((archivo) => ({ archivo, grupo: null, grupoElegido: false, esChat: false })))
    onCerrar()
  }

  return (
    <div className="conversacion-nueva" id={id} role="group" aria-labelledby={idTitulo}>
      <h3 className="subtitulo" id={idTitulo}>
        {yaElegidos
          ? archivos.length === 1
            ? 'Este archivo parece de un chat de WhatsApp'
            : `Estos ${archivos.length} archivos parecen de un chat de WhatsApp`
          : 'Armar una conversación'}
      </h3>
      <div className="campo">
        <label className="campo-etiqueta" htmlFor={idNombre}>
          {yaElegidos ? '¿De qué conversación son? Ponele un nombre' : '¿Cómo la reconocés?'}
        </label>
        <input
          ref={campo}
          id={idNombre}
          className="entrada-texto"
          type="text"
          value={nombre}
          placeholder="Ej.: Venta cerrada - María"
          autoComplete="off"
          enterKeyHint="done"
          aria-invalid={error !== null}
          aria-describedby={error ? `${idError} ${idAyuda}` : idAyuda}
          onChange={(evento) => {
            setNombre(evento.target.value)
            setError(null)
          }}
          onKeyDown={(evento) => {
            if (evento.key === 'Enter') {
              evento.preventDefault()
              seguir()
            }
            if (evento.key === 'Escape') onCerrar()
          }}
        />
        <p className="campo-ayuda" id={idAyuda}>
          {yaElegidos
            ? 'Así quedan juntos y no se mezclan con los de otro chat.'
            : 'Después elegí todos sus archivos juntos: el chat, las fotos, los audios y los videos.'}
        </p>
        {error && (
          <p className="campo-error" id={idError} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="acciones">
        <Boton onClick={seguir}>{yaElegidos ? 'Subir a esta conversación' : 'Elegir archivos'}</Boton>
        {yaElegidos && (
          <Boton variante="secundario" onClick={subirSueltos}>
            No son de una conversación
          </Boton>
        )}
        <Boton variante="texto" onClick={onCerrar}>
          Cancelar
        </Boton>
      </div>
      {/* Sin `accept`: así el celular ofrece fotos, videos y archivos. */}
      <input
        ref={selector}
        className="solo-lectores"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(evento) => {
          const elegidos = Array.from(evento.target.files ?? [])
          evento.target.value = ''
          if (elegidos.length > 0) subir(elegidos)
        }}
      />
    </div>
  )
}
