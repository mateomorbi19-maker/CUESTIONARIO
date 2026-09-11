import { useId, useState } from 'react'
import { AreaDeTexto, useBorrador, useFaltaTexto } from '../componentes/AreaDeTexto'
import { Boton } from '../componentes/Boton'
import { useCuestionario, useEnvio, type PantallaDe } from '../componentes/Contexto'
import { EsperaEnLinea } from '../componentes/Espera'
import { ListaDeMaterial } from '../componentes/ListaDeMaterial'
import { Aviso, MensajeError } from '../componentes/Mensajes'
import { SubidaDeArchivos } from '../componentes/SubidaDeArchivos'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/**
 * Antes de la entrevista: juntar chats y documentos. Lo que ya está escrito ahí después se le
 * muestra para confirmar en lugar de preguntárselo de cero.
 */
export function Material({ pantalla }: { pantalla: PantallaDe<'material'> }) {
  const { esperaEnLinea } = useCuestionario()
  const { mandar, enCurso, ocupado, error, errorDe } = useEnvio()
  const { texto, cambiar, descartar } = useBorrador('material')
  const [subiendo, setSubiendo] = useState(false)
  const id = useId()
  const idTexto = `${id}texto`
  const { falta, avisar, ocultar } = useFaltaTexto(idTexto, 'Pegá un texto antes de tocar «Agregar».')
  const bloqueado = ocupado || subiendo
  const cantidad = pantalla.archivos.length + pantalla.textos.length

  // Cada error al lado de lo que lo causó: la pantalla es larga y abajo de todo no se vería.
  const errorAgregar = errorDe('agregar')
  const errorLista = errorDe('quitar')
  const errorFinal = errorAgregar || errorLista ? null : error

  async function agregarTexto() {
    if (bloqueado) return
    const limpio = texto.trim()
    if (!limpio) return avisar()
    if (await mandar('agregar', { tipo: 'texto_material', texto: limpio })) descartar()
  }

  function escribir(valor: string) {
    ocultar()
    cambiar(valor)
  }

  return (
    <section className="pantalla">
      <h1 className="pregunta" tabIndex={-1}>
        Antes de seguir, juntá esto
      </h1>

      {pantalla.aviso && <Aviso texto={pantalla.aviso} />}

      <ul className="lista-material">
        {pantalla.items.map((item, i) => (
          <li key={i}>
            <TextoConNegritas texto={item} enLinea />
          </li>
        ))}
      </ul>

      <p className="consejo">Usá chats de las últimas semanas: tienen que mostrar cómo vendés hoy.</p>

      <div className="bloque">
        <h2 className="subtitulo">Subir archivos</h2>
        <SubidaDeArchivos
          textoBoton="Elegir archivos"
          ayuda="Capturas, fotos, PDF, Word, Excel, textos o el .zip que exporta WhatsApp. Hasta 20 MB cada uno."
          arrastrable
          onSubiendo={setSubiendo}
        />
      </div>

      {(cantidad > 0 || esperaEnLinea) && (
        <div className="bloque">
          <h2 className="subtitulo">Lo que ya sumaste</h2>
          {esperaEnLinea && <EsperaEnLinea mensaje={esperaEnLinea} />}
          <ListaDeMaterial
            archivos={pantalla.archivos}
            textos={pantalla.textos}
            bloqueado={subiendo}
            onQuitarTexto={(idTexto) => mandar(`quitar:${idTexto}`, { tipo: 'quitar_texto', id: idTexto })}
          />
          <MensajeError mensaje={errorLista} />
        </div>
      )}

      <form
        className="bloque"
        onSubmit={(evento) => {
          evento.preventDefault()
          void agregarTexto()
        }}
      >
        <AreaDeTexto
          id={idTexto}
          etiqueta="Pegar un texto"
          etiquetaComoTitulo
          ayuda="Un chat copiado, tu lista de precios, los mensajes que mandás siempre igual."
          valor={texto}
          onCambio={escribir}
          onEnviar={agregarTexto}
          invalido={falta !== null}
        />
        <MensajeError mensaje={falta ?? errorAgregar} />
        <div className="acciones">
          <Boton
            type="submit"
            variante="secundario"
            disabled={bloqueado}
            enCurso={enCurso === 'agregar'}
            textoEnCurso="Agregando…"
          >
            Agregar
          </Boton>
        </div>
      </form>

      <MensajeError mensaje={errorFinal} />
      <div className="acciones acciones-final">
        <Boton
          onClick={() => mandar('terminar', { tipo: 'terminar_material' })}
          disabled={bloqueado}
          enCurso={enCurso === 'terminar'}
        >
          {pantalla.aviso ? 'No tengo más, seguir' : 'Listo, seguir'}
        </Boton>
      </div>
    </section>
  )
}
