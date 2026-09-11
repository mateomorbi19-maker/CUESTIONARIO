import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { borrarBorrador, guardarBorrador, leerBorrador } from '@/lib/cliente-api'
import { useCuestionario } from './Contexto'

// En el servidor useLayoutEffect no corre; en el navegador ajusta el alto antes de pintar y el
// campo no parpadea mientras se escribe.
const useEfectoAntesDePintar = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Texto que se guarda en el dispositivo mientras se escribe (`borrador:<token>:<clave>`). Si se
 * corta internet, se cierra la pestaña o se apaga el celular, al volver está donde quedó.
 */
export function useBorrador(clave: string) {
  const { token } = useCuestionario()
  const [texto, setTexto] = useState('')

  useEffect(() => {
    // Recién acá: en el servidor no hay localStorage y el primer HTML tiene que coincidir.
    setTexto(leerBorrador(token, clave))
  }, [token, clave])

  const cambiar = useCallback(
    (nuevo: string) => {
      setTexto(nuevo)
      guardarBorrador(token, clave, nuevo)
    },
    [token, clave],
  )

  /** Después de un envío aceptado: lo escrito ya está en el servidor. */
  const descartar = useCallback(() => {
    setTexto('')
    borrarBorrador(token, clave)
  }, [token, clave])

  return { texto, cambiar, descartar }
}

/**
 * Para los botones de seguir: nunca quedan apagados sin explicación. Si los tocan sin escribir, se
 * dice qué falta al lado y el cursor vuelve al campo.
 */
export function useFaltaTexto(idCampo: string, mensaje: string) {
  const [visible, setVisible] = useState(false)

  const avisar = useCallback(() => {
    setVisible(true)
    document.getElementById(idCampo)?.focus()
  }, [idCampo])

  const ocultar = useCallback(() => setVisible(false), [])

  return { falta: visible ? mensaje : null, avisar, ocultar }
}

interface Props {
  id: string
  etiqueta: string
  valor: string
  onCambio: (valor: string) => void
  /**
   * Ctrl + Enter (⌘ + Enter en Mac) hace lo mismo que el botón principal. No se anuncia en
   * pantalla: a quien no usa atajos lo confundía, y el botón está siempre a la vista.
   */
  onEnviar?: () => void
  /** Ayuda debajo de la etiqueta. */
  ayuda?: string
  /** id de lo que describe el campo, normalmente la pregunta. */
  descritoPor?: string
  /** La etiqueta con tamaño de subtítulo, cuando encabeza un bloque. */
  etiquetaComoTitulo?: boolean
  /** Enfoca el campo al aparecer: solo cuando lo desplegó un toque del cliente. */
  enfocar?: boolean
  /** Se intentó seguir sin escribir nada: el borde se marca. */
  invalido?: boolean
}

export function AreaDeTexto({
  id,
  etiqueta,
  valor,
  onCambio,
  onEnviar,
  ayuda,
  descritoPor,
  etiquetaComoTitulo = false,
  enfocar = false,
  invalido = false,
}: Props) {
  const campo = useRef<HTMLTextAreaElement>(null)
  const idAyuda = `${id}-ayuda`

  useEfectoAntesDePintar(() => {
    const elemento = campo.current
    // Donde el navegador ya crece solo con el contenido (field-sizing en globals.css), no se toca.
    if (!elemento || CSS.supports('field-sizing', 'content')) return
    const desplazamiento = window.scrollY
    elemento.style.height = 'auto'
    const bordes = elemento.offsetHeight - elemento.clientHeight
    elemento.style.height = `${elemento.scrollHeight + bordes}px`
    // Pasar por 'auto' acorta la página un instante y el navegador puede saltar hacia arriba.
    if (window.scrollY !== desplazamiento) window.scrollTo(0, desplazamiento)
  }, [valor])

  useEffect(() => {
    if (enfocar) campo.current?.focus()
  }, [enfocar])

  function alTeclear(evento: KeyboardEvent<HTMLTextAreaElement>) {
    if (!onEnviar || evento.key !== 'Enter' || !(evento.ctrlKey || evento.metaKey)) return
    // Mientras se compone un carácter (acentos con teclado asiático, dictado) Enter no es enviar.
    if (evento.nativeEvent.isComposing) return
    evento.preventDefault()
    onEnviar()
  }

  const descripcion = [ayuda ? idAyuda : null, descritoPor].filter(Boolean).join(' ')

  return (
    <div className="campo">
      <label
        className={etiquetaComoTitulo ? 'campo-etiqueta subtitulo' : 'campo-etiqueta'}
        htmlFor={id}
      >
        {etiqueta}
      </label>
      {ayuda && (
        <p className="campo-ayuda" id={idAyuda}>
          {ayuda}
        </p>
      )}
      <textarea
        ref={campo}
        id={id}
        className="area-texto"
        value={valor}
        onChange={(evento) => onCambio(evento.target.value)}
        onKeyDown={alTeclear}
        aria-describedby={descripcion || undefined}
        aria-invalid={invalido || undefined}
        rows={4}
      />
    </div>
  )
}
