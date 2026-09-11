import { useId } from 'react'
import { AreaDeTexto, useBorrador } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { MensajeError } from '../componentes/Mensajes'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** Triage y reconstrucción del chat: una pregunta abierta por pantalla. */
export function Pregunta({ pantalla }: { pantalla: PantallaDe<'pregunta'> }) {
  const { texto, cambiar, descartar } = useBorrador(pantalla.clave)
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const id = useId()
  const idPregunta = `${id}pregunta`
  const completa = texto.trim() !== ''

  async function siguiente() {
    if (!completa || ocupado) return
    if (await mandar('siguiente', { tipo: 'respuesta', texto: texto.trim() })) descartar()
  }

  return (
    <section className="pantalla">
      {pantalla.introduccion && (
        <div className="introduccion">
          <TextoConNegritas texto={pantalla.introduccion} />
        </div>
      )}
      <div className="encabezado">
        {pantalla.esRepregunta && <p className="etiqueta-repregunta">Una más sobre esto</p>}
        <h1 className="pregunta" id={idPregunta} tabIndex={-1}>
          <TextoConNegritas texto={pantalla.texto} enLinea />
        </h1>
      </div>
      <form
        className="formulario"
        onSubmit={(evento) => {
          evento.preventDefault()
          void siguiente()
        }}
      >
        <AreaDeTexto
          id={`${id}respuesta`}
          etiqueta="Tu respuesta"
          valor={texto}
          onCambio={cambiar}
          onEnviar={siguiente}
          descritoPor={idPregunta}
        />
        <MensajeError mensaje={error} />
        <div className="acciones">
          <Boton type="submit" disabled={!completa || ocupado} enCurso={enCurso === 'siguiente'}>
            Siguiente
          </Boton>
        </div>
      </form>
    </section>
  )
}
