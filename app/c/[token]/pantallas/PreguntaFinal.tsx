import { useId } from 'react'
import { AreaDeTexto, useBorrador, useFaltaTexto } from '../componentes/AreaDeTexto'
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
  const idRespuesta = `${id}respuesta`
  const { falta, avisar, ocultar } = useFaltaTexto(
    idRespuesta,
    'Escribí tu respuesta para seguir. Si no lo sabés, tocá «No lo sé».',
  )

  async function siguiente() {
    if (ocupado) return
    if (!texto.trim()) return avisar()
    if (await mandar('siguiente', { tipo: 'respuesta', texto: texto.trim() })) descartar()
  }

  function escribir(valor: string) {
    ocultar()
    cambiar(valor)
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
          id={idRespuesta}
          etiqueta="Tu respuesta"
          valor={texto}
          onCambio={escribir}
          onEnviar={siguiente}
          descritoPor={idPregunta}
          invalido={falta !== null}
        />
        <MensajeError mensaje={falta ?? error} />
        <div className="acciones">
          <Boton type="submit" disabled={ocupado} enCurso={enCurso === 'siguiente'}>
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
