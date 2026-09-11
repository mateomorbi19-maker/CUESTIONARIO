import { useId, useState } from 'react'
import { AreaDeTexto, useBorrador } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useEnvio, type PantallaDe } from '../componentes/Contexto'
import { ListaDeMaterial } from '../componentes/ListaDeMaterial'
import { MensajeError } from '../componentes/Mensajes'
import { SubidaDeArchivos } from '../componentes/SubidaDeArchivos'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** Las respuestas del triage no alcanzaron: se pide un chat real, pegado o en capturas. */
export function PedidoChat({ pantalla }: { pantalla: PantallaDe<'pedido_chat'> }) {
  const { texto, cambiar, descartar } = useBorrador('chat')
  const { mandar, enCurso, ocupado, error } = useEnvio()
  const [subiendo, setSubiendo] = useState(false)
  const id = useId()
  const idPedido = `${id}pedido`
  const bloqueado = ocupado || subiendo
  const completo = texto.trim() !== '' || pantalla.archivos.length > 0

  async function listo() {
    if (!completo || bloqueado) return
    // Con capturas subidas el texto puede ir vacío: el servidor lee las imágenes.
    if (await mandar('listo', { tipo: 'respuesta', texto: texto.trim() })) descartar()
  }

  async function sinChat() {
    if (await mandar('sin_chat', { tipo: 'sin_chat' })) descartar()
  }

  return (
    <section className="pantalla">
      <h1 className="pregunta" id={idPedido} tabIndex={-1}>
        <TextoConNegritas texto={pantalla.texto} enLinea />
      </h1>
      <form
        className="formulario"
        onSubmit={(evento) => {
          evento.preventDefault()
          void listo()
        }}
      >
        <AreaDeTexto
          id={`${id}chat`}
          etiqueta="Pegá acá la conversación"
          valor={texto}
          onCambio={cambiar}
          onEnviar={listo}
          descritoPor={idPedido}
        />
        <div className="bloque">
          <h2 className="subtitulo">¿Preferís mandar capturas?</h2>
          <SubidaDeArchivos
            textoBoton="Subir capturas del chat"
            ayuda="Podés elegir varias a la vez. También sirve el .zip que exporta WhatsApp."
            onSubiendo={setSubiendo}
          />
          <ListaDeMaterial archivos={pantalla.archivos} bloqueado={subiendo} />
        </div>
        <MensajeError mensaje={error} />
        <div className="acciones acciones-final">
          <Boton type="submit" disabled={!completo || bloqueado} enCurso={enCurso === 'listo'}>
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
      </form>
    </section>
  )
}
