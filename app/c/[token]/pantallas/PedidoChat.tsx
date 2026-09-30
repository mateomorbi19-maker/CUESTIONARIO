import { useId, useState } from 'react'
import { AreaDeTexto, useBorrador, useFaltaTexto } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { ListaDeMaterial } from '../componentes/ListaDeMaterial'
import { MensajeError } from '../componentes/Mensajes'
import { PanelDeSubidas, ZonaDeSubida, useSubidas } from '../componentes/SubidaDeArchivos'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** Las respuestas del triage no alcanzaron: se pide un chat real, pegado o subido. */
export function PedidoChat({ pantalla }: { pantalla: PantallaDe<'pedido_chat'> }) {
  const { texto, cambiar, descartar } = useBorrador('chat')
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const { activos: subiendo, fallidos } = useSubidas()
  const [avisoFallidos, setAvisoFallidos] = useState(false)
  const id = useId()
  const idPedido = `${id}pedido`
  const idChat = `${id}chat`
  const idFormulario = `${id}formulario`
  const bloqueado = ocupado || subiendo
  const completo = texto.trim() !== '' || pantalla.archivos.length > 0
  const { falta, avisar, ocultar } = useFaltaTexto(
    idChat,
    'Pegá la conversación o subí el chat para seguir.',
  )
  // Si después del aviso subió el chat, ya no falta nada.
  const faltaVisible = completo ? null : falta

  async function listo() {
    if (bloqueado) return
    if (!completo) return avisar()
    if (fallidos > 0 && !avisoFallidos) {
      // Seguir ahora deja afuera lo que no se subió: que lo sepa antes. El segundo toque sigue.
      setAvisoFallidos(true)
      return
    }
    // Con archivos subidos el texto puede ir vacío: el servidor lee lo que subió.
    if (await mandar('listo', { tipo: 'respuesta', texto: texto.trim() })) descartar()
  }

  async function sinChat() {
    if (await mandar('sin_chat', { tipo: 'sin_chat' })) descartar()
  }

  function escribir(valor: string) {
    ocultar()
    cambiar(valor)
  }

  return (
    <section className="pantalla">
      <h1 className="pregunta" id={idPedido} tabIndex={-1}>
        <TextoConNegritas texto={pantalla.texto} enLinea />
      </h1>
      <div className="formulario">
        {/* El formulario es solo el campo: lo de subir tiene sus propios campos (el nombre de una
            conversación) y, adentro de este, un Enter ahí mandaría la pantalla entera. */}
        <form
          id={idFormulario}
          onSubmit={(evento) => {
            evento.preventDefault()
            void listo()
          }}
        >
          <AreaDeTexto
            id={idChat}
            etiqueta="Pegá acá la conversación"
            valor={texto}
            onCambio={escribir}
            onEnviar={listo}
            descritoPor={idPedido}
            invalido={faltaVisible !== null}
          />
        </form>
        <div className="bloque">
          <h2 className="subtitulo">¿Preferís subir el chat?</h2>
          <ZonaDeSubida variante="pedido_chat" />
          <PanelDeSubidas />
          <ListaDeMaterial archivos={pantalla.archivos} bloqueado={subiendo} variante="pedido_chat" />
        </div>
        <MensajeError mensaje={faltaVisible ?? error} />
        {avisoFallidos && fallidos > 0 && (
          <div className="aviso" role="alert">
            <p>
              {fallidos === 1
                ? 'Hay 1 archivo que no se subió. Reintentalo arriba, o tocá «Listo» de nuevo para seguir sin él.'
                : `Hay ${fallidos} archivos que no se subieron. Reintentalos arriba, o tocá «Listo» de nuevo para seguir sin ellos.`}
            </p>
          </div>
        )}
        <div className="acciones acciones-final">
          <Boton type="submit" form={idFormulario} disabled={bloqueado} enCurso={enCurso === 'listo'}>
            Listo
          </Boton>
          <Boton
            variante="secundario"
            onClick={sinChat}
            disabled={bloqueado}
            enCurso={enCurso === 'sin_chat'}
          >
            {pantalla.sinChat}
          </Boton>
        </div>
      </div>
    </section>
  )
}
