import { useEffect, useId, useRef, useState } from 'react'
import { AreaDeTexto, useBorrador, useFaltaTexto } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { MensajeError } from '../componentes/Mensajes'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

interface Props {
  pantalla: PantallaDe<'confirmacion'>
  /** Para la galería de /demo: arrancar con la corrección desplegada. */
  corrigiendoAlInicio?: boolean
}

/** Se le cuenta cómo se entendió su negocio y confirma o corrige. */
export function Confirmacion({ pantalla, corrigiendoAlInicio = false }: Props) {
  const [corrigiendo, setCorrigiendo] = useState(corrigiendoAlInicio)
  const [enfocar, setEnfocar] = useState(false)
  const { texto, cambiar, descartar } = useBorrador('correccion')
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const botonCorregir = useRef<HTMLButtonElement>(null)
  const abiertaPorBorrador = useRef(false)
  const id = useId()
  const idTexto = `${id}texto`
  const idCorreccion = `${id}correccion`
  const { falta, avisar, ocultar } = useFaltaTexto(
    idCorreccion,
    'Escribí qué hay que corregir para seguir.',
  )

  useEffect(() => {
    // Si había empezado a escribir una corrección y se fue, al volver la encuentra abierta.
    if (texto && !abiertaPorBorrador.current) {
      abiertaPorBorrador.current = true
      setCorrigiendo(true)
    }
  }, [texto])

  async function confirmar() {
    if (await mandar('confirmar', { tipo: 'confirmar' })) descartar()
  }

  async function enviarCorreccion() {
    if (ocupado) return
    const limpio = texto.trim()
    if (!limpio) return avisar()
    if (await mandar('corregir', { tipo: 'corregir', texto: limpio })) descartar()
  }

  function escribir(valor: string) {
    ocultar()
    cambiar(valor)
  }

  function abrir() {
    setEnfocar(true)
    setCorrigiendo(true)
  }

  function cancelar() {
    ocultar()
    setCorrigiendo(false)
    // El botón que desplegó la corrección vuelve a aparecer: el foco va ahí y no se pierde. Con
    // setTimeout y no requestAnimationFrame: React ya confirmó el cambio y no depende de que se pinte.
    window.setTimeout(() => botonCorregir.current?.focus(), 0)
  }

  return (
    <section className="pantalla">
      <h1 className="solo-lectores" tabIndex={-1}>
        Revisá si entendimos bien tu negocio
      </h1>
      <div className="texto-largo" id={idTexto}>
        <TextoConNegritas texto={pantalla.texto} />
      </div>

      {corrigiendo ? (
        <form
          className="formulario"
          onSubmit={(evento) => {
            evento.preventDefault()
            void enviarCorreccion()
          }}
        >
          <AreaDeTexto
            id={idCorreccion}
            etiqueta="¿Qué hay que corregir?"
            ayuda="Contalo con tus palabras, como se lo explicarías a alguien que recién empieza en tu negocio."
            valor={texto}
            onCambio={escribir}
            onEnviar={enviarCorreccion}
            descritoPor={idTexto}
            enfocar={enfocar}
            invalido={falta !== null}
          />
          <MensajeError mensaje={falta ?? error} />
          <div className="acciones">
            <Boton type="submit" disabled={ocupado} enCurso={enCurso === 'corregir'}>
              Enviar corrección
            </Boton>
            <Boton variante="texto" onClick={cancelar} disabled={ocupado}>
              Cancelar
            </Boton>
          </div>
        </form>
      ) : (
        <>
          <MensajeError mensaje={error} />
          <div className="acciones">
            <Boton onClick={confirmar} disabled={ocupado} enCurso={enCurso === 'confirmar'}>
              Sí, es así
            </Boton>
            <Boton ref={botonCorregir} variante="secundario" onClick={abrir} disabled={ocupado}>
              No, te corrijo
            </Boton>
          </div>
        </>
      )}
    </section>
  )
}
