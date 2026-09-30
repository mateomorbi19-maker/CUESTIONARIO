import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArchivoPublico, TextoPublico } from '@/lib/motor/tipos'
import { useCuestionario } from './Contexto'
import { IconoTexto } from './Iconos'
import { TarjetaConversacion } from './TarjetaConversacion'

interface Props {
  archivos: ArchivoPublico[]
  textos?: TextoPublico[]
  /** Hay subidas en fila: quitar ahora podría pisarse con ellas en el servidor. */
  bloqueado?: boolean
  /** Los textos se quitan con una entrada, no con la ruta de archivos. */
  onQuitarTexto?: (id: string) => Promise<boolean>
  /** En el pedido de chat los sueltos son capturas, no «otros archivos». */
  variante?: 'material' | 'pedido_chat'
}

interface Conversacion {
  grupo: string
  archivos: ArchivoPublico[]
  mismaQue: string | null
}

/** Las conversaciones en el orden en que aparecieron, y aparte lo que no es de ninguna. */
function agrupar(archivos: ArchivoPublico[]): { conversaciones: Conversacion[]; sueltos: ArchivoPublico[] } {
  const porGrupo = new Map<string, ArchivoPublico[]>()
  const sueltos: ArchivoPublico[] = []
  for (const archivo of archivos) {
    // Los cuestionarios empezados antes de que hubiera conversaciones no traen grupo: van sueltos.
    const grupo = archivo.grupo ?? null
    if (grupo === null) sueltos.push(archivo)
    else porGrupo.set(grupo, [...(porGrupo.get(grupo) ?? []), archivo])
  }

  // La misma conversación subida dos veces (el .zip y también la carpeta, por ejemplo). Acá no
  // llega el contenido, así que se compara por nombre y peso: tiene que coincidir el chat y,
  // además, todo lo de una tiene que estar en la otra. Solo con el chat, dos chats cortos del
  // mismo tamaño pasarían por la misma conversación y el aviso invitaría a quitar una que no sobra.
  const huella = (archivo: ArchivoPublico) => `${archivo.nombre}\n${archivo.bytes}`
  const contiene = (grande: ArchivoPublico[], chica: ArchivoPublico[]) => {
    const huellas = new Set(grande.map(huella))
    return chica.every((archivo) => huellas.has(huella(archivo)))
  }
  const anteriores: Conversacion[] = []
  const conversaciones = [...porGrupo].map(([grupo, suyos]): Conversacion => {
    const chat = suyos.find((archivo) => archivo.esChat)
    const igual = chat
      ? anteriores.find(
          (otra) =>
            otra.archivos.some((archivo) => archivo.esChat && huella(archivo) === huella(chat)) &&
            (contiene(otra.archivos, suyos) || contiene(suyos, otra.archivos)),
        )
      : undefined
    const conversacion = { grupo, archivos: suyos, mismaQue: igual?.grupo ?? null }
    anteriores.push(conversacion)
    return conversacion
  })
  return { conversaciones, sueltos }
}

/**
 * Lo que ya está guardado en el servidor: una tarjeta por conversación, después los archivos que
 * no son de ninguna y al final los textos pegados, cada cosa con su «Quitar».
 */
export function ListaDeMaterial({
  archivos,
  textos = [],
  bloqueado = false,
  onQuitarTexto,
  variante = 'material',
}: Props) {
  const { ocupado } = useCuestionario()
  const [quitando, setQuitando] = useState<string | null>(null)
  const contenedor = useRef<HTMLDivElement>(null)
  const { conversaciones, sueltos } = useMemo(() => agrupar(archivos), [archivos])

  useEffect(() => {
    // Quitar un texto es una entrada que se procesa: sigue en «Quitando…» hasta que termina.
    if (!ocupado) setQuitando(null)
  }, [ocupado])

  if (archivos.length === 0 && textos.length === 0) return null

  async function quitarUnTexto(texto: TextoPublico) {
    if (!onQuitarTexto) return
    setQuitando(texto.id)
    if (!(await onQuitarTexto(texto.id))) setQuitando(null)
  }

  function alQuitarConversacion() {
    // La tarjeta desaparece con el foco adentro: va a la lista, que es donde estaba mirando.
    window.setTimeout(() => contenedor.current?.focus(), 0)
  }

  const nombres = conversaciones.map(({ grupo }) => grupo)

  return (
    <div className="conversaciones" ref={contenedor} tabIndex={-1}>
      {conversaciones.map((conversacion) => (
        <TarjetaConversacion
          // Por su primer archivo y no por su nombre: al cambiarle el nombre sigue siendo la misma
          // tarjeta y no pierde el foco ni lo que tenía abierto.
          key={conversacion.archivos[0].id}
          grupo={conversacion.grupo}
          archivos={conversacion.archivos}
          mismaQue={conversacion.mismaQue}
          otrosGrupos={nombres.filter((nombre) => nombre !== conversacion.grupo)}
          bloqueado={bloqueado}
          variante={variante}
          onQuitada={alQuitarConversacion}
        />
      ))}
      {sueltos.length > 0 && (
        <TarjetaConversacion
          key="sueltos"
          grupo={null}
          archivos={sueltos}
          mismaQue={null}
          otrosGrupos={nombres}
          bloqueado={bloqueado}
          variante={variante}
          onQuitada={alQuitarConversacion}
        />
      )}
      {textos.length > 0 && (
        <ul className="lista-archivos">
          {textos.map((texto) => (
            <li key={texto.id} className="archivo">
              <IconoTexto className="archivo-icono" />
              <div className="archivo-cuerpo">
                <span className="archivo-nombre">{texto.extracto}</span>
                <span className="archivo-detalle">Texto pegado</span>
              </div>
              {onQuitarTexto && (
                <button
                  type="button"
                  className="boton boton-texto archivo-accion"
                  onClick={() => quitarUnTexto(texto)}
                  disabled={bloqueado || ocupado || quitando !== null}
                  aria-label={`Quitar el texto que empieza con «${texto.extracto.slice(0, 40)}»`}
                >
                  {quitando === texto.id ? 'Quitando…' : 'Quitar'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
