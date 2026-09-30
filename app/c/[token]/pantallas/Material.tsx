import { useEffect, useId, useRef, useState } from 'react'
import { AVISO_EN_PROCESO, AVISO_LECTURA } from '@/lib/motor/textos'
import { Boton } from '../componentes/Boton'
import { useCuestionario, useEnvio, type PantallaDe } from '../componentes/Contexto'
import { EsperaEnLinea } from '../componentes/Espera'
import { ListaDeMaterial } from '../componentes/ListaDeMaterial'
import { Aviso, MensajeError } from '../componentes/Mensajes'
import { NuevaConversacion } from '../componentes/NuevaConversacion'
import { PanelDeSubidas, ZonaDeSubida, useSubidas } from '../componentes/SubidaDeArchivos'
import { TextoConNegritas } from '../componentes/TextoConNegritas'

/** Cada cuánto se mira si ya terminaron de escucharse los audios y videos. */
const INTERVALO_ESCUCHA_MS = 20_000
// Cuando termina de escuchar, la pantalla sigue sola. El tope es por si algo anda mal del otro
// lado y vuelve siempre acá: cada vuelta le cuesta minutos al servidor, y pasado esto decide ella.
const MAXIMO_SEGUIR_SOLO = 8
// Por cuestionario y mientras dure la página: la pantalla se arma de nuevo después de cada espera.
const vecesQueSiguioSolo = new Map<string, number>()

/**
 * Antes de la entrevista: juntar las conversaciones y los documentos. Lo que ya está escrito ahí
 * después se le muestra para confirmar en lugar de preguntárselo de cero.
 *
 * Solo se suben archivos. Un campo para pegar texto suelto confundía («¿texto de qué?») y todo
 * lo que sirve entra como archivo. La lista igual muestra los textos pegados de cuestionarios
 * empezados antes, para poder quitarlos.
 */
export function Material({ pantalla }: { pantalla: PantallaDe<'material'> }) {
  const { esperaEnLinea, recargar, token } = useCuestionario()
  const { mandar, enCurso, ocupado, error, errorDe } = useEnvio()
  const { activos: subiendo, fallidos } = useSubidas()
  // null: cerrado. Con archivos: los sueltos que parecen de un chat y falta saber de cuál.
  const [armando, setArmando] = useState<File[] | null>(null)
  const [avisoFallidos, setAvisoFallidos] = useState(false)
  const [consultas, setConsultas] = useState(0)
  const siguioSolo = useRef(false)
  const id = useId()
  const idBotonArmar = `${id}armar`
  const idFormulario = `${id}conversacion`
  const idPanel = `${id}subidas`

  const bloqueado = ocupado || subiendo
  const cantidad = pantalla.archivos.length + pantalla.textos.length
  const enProceso = pantalla.archivos.filter((archivo) => archivo.estado === 'en_proceso').length
  const escuchando = pantalla.avisoLectura === AVISO_EN_PROCESO
  // Los cuestionarios empezados antes no traen el aviso: si tienen un archivo con nota, se dice igual.
  const avisoLectura =
    pantalla.avisoLectura ??
    (pantalla.archivos.some((archivo) => archivo.estado === 'con_problema') ? AVISO_LECTURA : null)
  const sigueSolo = escuchando && (vecesQueSiguioSolo.get(token) ?? 0) < MAXIMO_SEGUIR_SOLO

  // El error de quitar va junto a la lista: la pantalla es larga y abajo de todo no se vería.
  const errorLista = errorDe('quitar')
  const errorFinal = errorLista ? null : error

  useEffect(() => {
    // Volvió acá porque todavía se estaban escuchando audios o videos. Eso sigue en el servidor
    // sin tocar el estado: se pregunta cada tanto y, cuando no queda ninguno, se sigue sin que
    // tenga que tocar nada. Con algo subiendo o fallado no: eso lo tiene que ver ella.
    if (!sigueSolo || ocupado || subiendo || fallidos > 0) return
    if (enProceso > 0) {
      const temporizador = window.setTimeout(() => {
        // Salga bien o mal, cuenta una consulta más: así se programa la siguiente aunque esta
        // haya fallado por la conexión y el estado no haya cambiado.
        void recargar().finally(() => setConsultas((n) => n + 1))
      }, INTERVALO_ESCUCHA_MS)
      return () => window.clearTimeout(temporizador)
    }
    // Una sola vez por pantalla: si el envío no se acepta, queda el error a la vista y el botón.
    if (siguioSolo.current) return
    siguioSolo.current = true
    vecesQueSiguioSolo.set(token, (vecesQueSiguioSolo.get(token) ?? 0) + 1)
    void mandar('terminar', { tipo: 'terminar_material' })
    // `mandar` queda afuera: se rearma en cada render y acá solo importa cuándo cambia lo demás.
  }, [sigueSolo, enProceso, ocupado, subiendo, fallidos, consultas, token, recargar])

  function cerrarArmado() {
    setArmando(null)
    // El foco vuelve al botón que abrió el formulario y no se pierde en la página.
    window.setTimeout(() => document.getElementById(idBotonArmar)?.focus(), 0)
  }

  function seguir() {
    if (fallidos > 0 && !avisoFallidos) {
      // Seguir ahora deja afuera lo que no se subió: que lo sepa antes.
      setAvisoFallidos(true)
      return
    }
    void mandar('terminar', { tipo: 'terminar_material' })
  }

  function verFallidos() {
    setAvisoFallidos(false)
    const panel = document.getElementById(idPanel)
    panel?.focus({ preventScroll: true })
    panel?.scrollIntoView({ block: 'center' })
  }

  return (
    <section className="pantalla">
      <h1 className="pregunta" tabIndex={-1}>
        Antes de seguir, juntá esto
      </h1>

      {pantalla.aviso && <Aviso texto={pantalla.aviso} />}
      {avisoLectura && <Aviso texto={avisoLectura} />}
      {sigueSolo && enProceso > 0 && (
        <EsperaEnLinea mensaje="Seguimos escuchando. Cuando termine, el cuestionario sigue solo: no hace falta que toques nada." />
      )}

      <ul className="lista-material">
        {pantalla.items.map((item, i) => (
          <li key={i}>
            <TextoConNegritas texto={item} enLinea />
          </li>
        ))}
      </ul>

      <p className="consejo">Usá chats de las últimas semanas: tienen que mostrar cómo vendés hoy.</p>

      <div className="bloque">
        <h2 className="subtitulo">Subí las conversaciones</h2>
        <p>
          Subí cada conversación entera: el chat con sus fotos, audios, videos y PDF. Así cada una
          queda separada y no se mezcla con las otras.
        </p>
        <ZonaDeSubida
          variante="material"
          armar={{ idBoton: idBotonArmar, idFormulario, abierto: armando !== null, abrir: setArmando }}
        />
        {armando && <NuevaConversacion id={idFormulario} archivos={armando} onCerrar={cerrarArmado} />}
        <PanelDeSubidas id={idPanel} />
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
      {avisoFallidos && fallidos > 0 && (
        <div className="aviso" role="alert">
          <p>
            {fallidos === 1
              ? 'Hay 1 archivo que no se subió. Podés reintentarlo o seguir sin él.'
              : `Hay ${fallidos} archivos que no se subieron. Podés reintentarlos o seguir sin ellos.`}
          </p>
        </div>
      )}
      <div className="acciones acciones-final">
        <Boton onClick={seguir} disabled={bloqueado} enCurso={enCurso === 'terminar'}>
          {avisoFallidos && fallidos > 0
            ? 'Seguir igual'
            : pantalla.aviso
              ? 'No tengo más, seguir'
              : 'Listo, seguir'}
        </Boton>
        {avisoFallidos && fallidos > 0 && (
          <Boton variante="secundario" onClick={verFallidos}>
            Ver lo que no se subió
          </Boton>
        )}
      </div>
    </section>
  )
}
