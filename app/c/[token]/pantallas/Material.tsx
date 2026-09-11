import { useState } from 'react'
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
 *
 * Solo se suben archivos. Un campo para pegar texto suelto confundía («¿texto de qué?») y todo
 * lo que sirve entra como archivo: capturas, el chat exportado, PDF, Word o Excel. La lista
 * igual muestra los textos pegados de cuestionarios empezados antes, para poder quitarlos.
 */
export function Material({ pantalla }: { pantalla: PantallaDe<'material'> }) {
  const { esperaEnLinea } = useCuestionario()
  const { mandar, enCurso, ocupado, error, errorDe } = useEnvio()
  const [subiendo, setSubiendo] = useState(false)
  const bloqueado = ocupado || subiendo
  const cantidad = pantalla.archivos.length + pantalla.textos.length

  // El error de quitar va junto a la lista: la pantalla es larga y abajo de todo no se vería.
  const errorLista = errorDe('quitar')
  const errorFinal = errorLista ? null : error

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
          ayuda="Capturas de los chats, el chat que exporta WhatsApp, fotos, PDF, Word o Excel. Hasta 20 MB cada uno."
          arrastrable
          onSubiendo={setSubiendo}
        />
      </div>

      {(cantidad > 0 || esperaEnLinea) && (
        <div className="bloque">
          <h2 className="subtitulo">Lo que ya subiste</h2>
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
