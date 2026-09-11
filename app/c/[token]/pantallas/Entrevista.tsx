import { useId, useRef, useState, type RefObject } from 'react'
import type { Propuesta } from '@/lib/motor/tipos'
import { AreaDeTexto, useBorrador, useFaltaTexto } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { MensajeError } from '../componentes/Mensajes'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

// El cuestionario siempre tiene nueve secciones: lo verifica el motor al armarlo.
const TOTAL_SECCIONES = 9
const AYUDA_LITERAL = 'Pegalo tal cual se lo mandás a un cliente, con tus palabras y emojis.'

type Modo = 'responder' | 'cambio' | 'no_aplica'

interface Props {
  pantalla: PantallaDe<'entrevista'>
  /** Para la galería de /demo: arrancar con «Cambió» o «No aplica» desplegados. */
  modoInicial?: Modo
}

/** Una pregunta del cuestionario a medida, con salidas para lo que no sabe o no aplica. */
export function Entrevista({ pantalla, modoInicial = 'responder' }: Props) {
  const { seccion, pregunta, formato, propuesta, repregunta } = pantalla
  // Hay un único botón principal a la vista: cada desplegable reemplaza al formulario de arriba.
  const [modo, setModo] = useState<Modo>(
    modoInicial === 'cambio' && !propuesta ? 'responder' : modoInicial,
  )
  const [enfocar, setEnfocar] = useState(false)
  const respuesta = useBorrador(pregunta.id)
  const motivo = useBorrador(`motivo.${pregunta.id}`)
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const botonCambio = useRef<HTMLButtonElement>(null)
  const botonNoAplica = useRef<HTMLButtonElement>(null)
  const id = useId()
  const idPregunta = `${id}pregunta`
  const idRespuesta = `${id}respuesta`
  const idMotivo = `${id}motivo`
  const faltaRespuesta = useFaltaTexto(
    idRespuesta,
    'Escribí tu respuesta para seguir. Si no lo sabés, tocá «No lo sé».',
  )
  const faltaMotivo = useFaltaTexto(idMotivo, 'Contá por qué no aplica a tu negocio para seguir.')

  function cambiarModo(nuevo: Modo, devolverFocoA?: RefObject<HTMLButtonElement | null>) {
    setModo(nuevo)
    setEnfocar(nuevo !== 'responder')
    // Al cerrar un desplegable el foco vuelve al botón que lo abrió y no se pierde en la página. Con
    // setTimeout y no requestAnimationFrame: React ya confirmó el cambio y no depende de que se pinte.
    if (devolverFocoA) window.setTimeout(() => devolverFocoA.current?.focus(), 0)
  }

  function escribirRespuesta(valor: string) {
    faltaRespuesta.ocultar()
    respuesta.cambiar(valor)
  }

  function escribirMotivo(valor: string) {
    faltaMotivo.ocultar()
    motivo.cambiar(valor)
  }

  async function mandarRespuesta() {
    if (ocupado) return
    const limpio = respuesta.texto.trim()
    if (!limpio) return faltaRespuesta.avisar()
    if (await mandar('respuesta', { tipo: 'respuesta', texto: limpio })) respuesta.descartar()
  }

  async function mandarMotivo() {
    if (ocupado) return
    const limpio = motivo.texto.trim()
    if (!limpio) return faltaMotivo.avisar()
    if (await mandar('no_aplica', { tipo: 'no_aplica', texto: limpio })) motivo.descartar()
  }

  const bloqueRepregunta = repregunta && (
    <div className="destacado">
      <p className="destacado-etiqueta">Una más sobre esto</p>
      <TextoConNegritas texto={repregunta} />
    </div>
  )

  const conFormulario = modo === 'cambio' || (modo === 'responder' && !propuesta)

  return (
    <section className="pantalla">
      <div className="encabezado">
        <p className="antetitulo">
          Sección {seccion.numero} de {TOTAL_SECCIONES} · {seccion.titulo}
        </p>
        <h1 className="pregunta" id={idPregunta} tabIndex={-1}>
          <TextoConNegritas texto={pregunta.texto} enLinea />
        </h1>
      </div>

      {modo === 'responder' && propuesta && (
        <div className="bloque">
          <Cita propuesta={propuesta} />
          {bloqueRepregunta}
          <MensajeError mensaje={error} />
          <div className="acciones">
            <Boton
              onClick={() => mandar('sigue_igual', { tipo: 'sigue_igual' })}
              disabled={ocupado}
              enCurso={enCurso === 'sigue_igual'}
            >
              Sigue así
            </Boton>
            <Boton
              ref={botonCambio}
              variante="secundario"
              onClick={() => cambiarModo('cambio')}
              disabled={ocupado}
            >
              Cambió
            </Boton>
          </div>
        </div>
      )}

      {conFormulario && (
        <form
          className="formulario"
          onSubmit={(evento) => {
            evento.preventDefault()
            void mandarRespuesta()
          }}
        >
          {modo === 'cambio' && propuesta && <Cita propuesta={propuesta} />}
          {bloqueRepregunta}
          <AreaDeTexto
            id={idRespuesta}
            etiqueta={modo === 'cambio' ? 'Escribí cómo es ahora' : 'Tu respuesta'}
            ayuda={formato === 'texto_literal' ? AYUDA_LITERAL : undefined}
            valor={respuesta.texto}
            onCambio={escribirRespuesta}
            onEnviar={mandarRespuesta}
            descritoPor={idPregunta}
            enfocar={enfocar && modo === 'cambio'}
            invalido={faltaRespuesta.falta !== null}
          />
          {modo === 'cambio' && propuesta && !respuesta.texto && (
            // Si cambió una frase de un texto largo, reescribirlo entero desde el celular es mucho.
            <button
              type="button"
              className="boton boton-texto boton-chico"
              onClick={() => escribirRespuesta(propuesta.texto)}
            >
              Copiar el texto de arriba para editarlo
            </button>
          )}
          <MensajeError mensaje={faltaRespuesta.falta ?? error} />
          <div className="acciones">
            <Boton type="submit" disabled={ocupado} enCurso={enCurso === 'respuesta'}>
              Siguiente
            </Boton>
            {modo === 'cambio' && (
              <Boton
                variante="texto"
                onClick={() => cambiarModo('responder', botonCambio)}
                disabled={ocupado}
              >
                Cancelar
              </Boton>
            )}
          </div>
        </form>
      )}

      <div className="salidas">
        <Boton
          variante="texto"
          onClick={() => mandar('no_se', { tipo: 'no_se' })}
          disabled={ocupado}
          enCurso={enCurso === 'no_se'}
        >
          No lo sé
        </Boton>
        <Boton
          ref={botonNoAplica}
          variante="texto"
          aria-expanded={modo === 'no_aplica'}
          onClick={() =>
            modo === 'no_aplica'
              ? cambiarModo('responder', botonNoAplica)
              : cambiarModo('no_aplica')
          }
          disabled={ocupado}
        >
          No aplica a mi negocio
        </Boton>
      </div>

      {modo === 'no_aplica' && (
        <form
          className="formulario"
          onSubmit={(evento) => {
            evento.preventDefault()
            void mandarMotivo()
          }}
        >
          <AreaDeTexto
            id={idMotivo}
            etiqueta="¿Por qué no aplica a tu negocio?"
            valor={motivo.texto}
            onCambio={escribirMotivo}
            onEnviar={mandarMotivo}
            descritoPor={idPregunta}
            enfocar={enfocar}
            invalido={faltaMotivo.falta !== null}
          />
          <MensajeError mensaje={faltaMotivo.falta ?? error} />
          <div className="acciones">
            <Boton type="submit" disabled={ocupado} enCurso={enCurso === 'no_aplica'}>
              Siguiente
            </Boton>
            <Boton
              variante="texto"
              onClick={() => cambiarModo('responder', botonNoAplica)}
              disabled={ocupado}
            >
              Cancelar
            </Boton>
          </div>
        </form>
      )}
    </section>
  )
}

/** Lo que ya dice su material sobre esta pregunta, tal cual, para que confirme si sigue así. */
function Cita({ propuesta }: { propuesta: Propuesta }) {
  return (
    <figure className="propuesta">
      <figcaption className="propuesta-titulo">En lo que subiste dice:</figcaption>
      {/* Sin negritas ni nada: es su texto y se muestra letra por letra. */}
      <blockquote className="propuesta-cita">{propuesta.texto}</blockquote>
      <p className="propuesta-fuente">Fuente: {propuesta.fuente}</p>
    </figure>
  )
}
