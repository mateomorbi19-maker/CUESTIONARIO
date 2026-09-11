import { useEffect, useState } from 'react'
import type { ArchivoPublico, TextoPublico, TipoMaterial } from '@/lib/motor/tipos'
import { useCuestionario } from './Contexto'
import { IconoDocumento, IconoImagen, IconoTexto } from './Iconos'

const NOMBRE_TIPO: Record<TipoMaterial, string> = {
  imagen: 'Imagen',
  pdf: 'PDF',
  texto: 'Texto',
}

interface Props {
  archivos: ArchivoPublico[]
  textos?: TextoPublico[]
  /** Hay subidas en fila: quitar ahora podría pisarse con ellas en el servidor. */
  bloqueado?: boolean
  /** Los textos se quitan con una entrada, no con la ruta de archivos. */
  onQuitarTexto?: (id: string) => Promise<boolean>
}

/** Lo que ya está guardado en el servidor, cada cosa con su «Quitar». */
export function ListaDeMaterial({ archivos, textos = [], bloqueado = false, onQuitarTexto }: Props) {
  const { quitarArchivo, ocupado } = useCuestionario()
  const [quitando, setQuitando] = useState<string | null>(null)
  const [errores, setErrores] = useState<Record<string, string>>({})

  useEffect(() => {
    // Quitar un texto es una entrada que se procesa: sigue en «Quitando…» hasta que termina.
    if (!ocupado) setQuitando(null)
  }, [ocupado])

  if (archivos.length === 0 && textos.length === 0) return null

  async function quitarUnArchivo(archivo: ArchivoPublico) {
    setQuitando(archivo.id)
    setErrores(({ [archivo.id]: _anterior, ...resto }) => resto)
    const resultado = await quitarArchivo(archivo.id)
    setQuitando(null)
    if (!resultado.ok) setErrores((actuales) => ({ ...actuales, [archivo.id]: resultado.error }))
  }

  async function quitarUnTexto(texto: TextoPublico) {
    if (!onQuitarTexto) return
    setQuitando(texto.id)
    if (!(await onQuitarTexto(texto.id))) setQuitando(null)
  }

  const deshabilitado = bloqueado || ocupado || quitando !== null

  return (
    <ul className="lista-archivos">
      {archivos.map((archivo) => (
        <li key={archivo.id} className="archivo">
          <IconoDeTipo tipo={archivo.tipo} />
          <div className="archivo-cuerpo">
            <span className="archivo-nombre">{archivo.nombre}</span>
            <span className="archivo-detalle">{NOMBRE_TIPO[archivo.tipo]}</span>
            {errores[archivo.id] && (
              <span className="archivo-error" role="alert">
                {errores[archivo.id]}
              </span>
            )}
          </div>
          <button
            type="button"
            className="boton boton-texto archivo-accion"
            onClick={() => quitarUnArchivo(archivo)}
            disabled={deshabilitado}
            aria-label={`Quitar ${archivo.nombre}`}
          >
            {quitando === archivo.id ? 'Quitando…' : 'Quitar'}
          </button>
        </li>
      ))}
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
              disabled={deshabilitado}
              aria-label={`Quitar el texto que empieza con «${texto.extracto.slice(0, 40)}»`}
            >
              {quitando === texto.id ? 'Quitando…' : 'Quitar'}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function IconoDeTipo({ tipo }: { tipo: TipoMaterial }) {
  if (tipo === 'imagen') return <IconoImagen className="archivo-icono" />
  if (tipo === 'pdf') return <IconoDocumento className="archivo-icono" />
  return <IconoTexto className="archivo-icono" />
}
