import { useId } from 'react'
import { AreaDeTexto, useBorrador } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { MensajeError } from '../componentes/Mensajes'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** Lo que quedó incompleto al cerrar la entrevista, preguntado como una pregunta más. */
export function PreguntaFinal({ pantalla }: { pantalla: PantallaDe<'pregunta_final'> }) {
  const { texto, cambiar, descartar } = useBorrador(`final.${pantalla.numero}`)
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
      <div className="encabezado">
        <p className="antetitulo">
          Últimas preguntas · {pantalla.numero} de {pantalla.total}
        </p>
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
      <div className="salidas">
        <Boton
          variante="texto"
          onClick={() => mandar('no_se', { tipo: 'no_se' })}
          disabled={ocupado}
          enCurso={enCurso === 'no_se'}
        >
          No lo sé
        </Boton>
      </div>
    </section>
  )
}
