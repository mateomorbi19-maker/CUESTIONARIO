import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { sanearGrupo } from '@/lib/grupos'
import type { ArchivoPublico, TipoMaterial } from '@/lib/motor/tipos'
import { Boton } from './Boton'
import { useCuestionario } from './Contexto'
import {
  IconoArchivo,
  IconoAudio,
  IconoCarpeta,
  IconoChat,
  IconoDocumento,
  IconoImagen,
  IconoTexto,
  IconoVideo,
} from './Iconos'
import { useSubidas } from './SubidaDeArchivos'

const NOMBRE_TIPO: Record<TipoMaterial, string> = {
  imagen: 'Imagen',
  pdf: 'PDF',
  texto: 'Texto',
  audio: 'Audio',
  video: 'Video',
  otro: 'Archivo',
}

interface Props {
  /** null: los archivos que no son de ninguna conversación. */
  grupo: string | null
  archivos: ArchivoPublico[]
  /** Otra conversación que tiene el mismo chat: casi seguro la subieron dos veces. */
  mismaQue: string | null
  /** Los nombres de las demás, para no dejar dos iguales. */
  otrosGrupos: string[]
  /** Hay subidas en fila: quitar o renombrar ahora podría pisarse con ellas en el servidor. */
  bloqueado: boolean
  variante: 'material' | 'pedido_chat'
  /** Se quitó entera: la tarjeta desaparece y el foco necesita a dónde ir. */
  onQuitada: () => void
}

type Modo = 'ver' | 'nombre' | 'quitar'

function contar(n: number, uno: string, varios: string): string {
  return n === 1 ? `1 ${uno}` : `${n} ${varios}`
}

/** «Chat · 7 audios · 5 fotos · 2 PDF · 1 video · 3 archivos», solo con lo que hay. */
function resumenDe(archivos: ArchivoPublico[]): string {
  const chats = archivos.filter((archivo) => archivo.esChat).length
  const de = (...tipos: TipoMaterial[]) =>
    archivos.filter((archivo) => !archivo.esChat && tipos.includes(archivo.tipo)).length
  const partes: string[] = []
  if (chats === 1) partes.push('Chat')
  if (chats > 1) partes.push(`${chats} chats`)
  if (de('audio')) partes.push(contar(de('audio'), 'audio', 'audios'))
  if (de('imagen')) partes.push(contar(de('imagen'), 'foto', 'fotos'))
  if (de('pdf')) partes.push(`${de('pdf')} PDF`)
  if (de('video')) partes.push(contar(de('video'), 'video', 'videos'))
  if (de('texto', 'otro')) partes.push(contar(de('texto', 'otro'), 'archivo', 'archivos'))
  return partes.join(' · ')
}

function duracionLegible(segundos: number): string {
  const total = Math.max(0, Math.round(segundos))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function detalleDe(archivo: ArchivoPublico): string {
  const partes = [archivo.esChat ? 'Chat' : NOMBRE_TIPO[archivo.tipo]]
  if (typeof archivo.duracion === 'number') partes.push(duracionLegible(archivo.duracion))
  if (archivo.estado === 'en_proceso') partes.push('lo estamos escuchando')
  return partes.join(' · ')
}

function IconoDeArchivo({ archivo }: { archivo: ArchivoPublico }) {
  if (archivo.esChat) return <IconoChat className="archivo-icono" />
  switch (archivo.tipo) {
    case 'imagen':
      return <IconoImagen className="archivo-icono" />
    case 'pdf':
      return <IconoDocumento className="archivo-icono" />
    case 'texto':
      return <IconoTexto className="archivo-icono" />
    case 'audio':
      return <IconoAudio className="archivo-icono" />
    case 'video':
      return <IconoVideo className="archivo-icono" />
    default:
      return <IconoArchivo className="archivo-icono" />
  }
}

/**
 * Una conversación subida: su nombre, qué tiene y qué se puede hacer con ella. Los archivos
 * quedan plegados salvo que alguno tenga una nota: ahí se abre sola, para que la nota se vea.
 */
export function TarjetaConversacion({
  grupo,
  archivos,
  mismaQue,
  otrosGrupos,
  bloqueado,
  variante,
  onQuitada,
}: Props) {
  const { quitarArchivo, quitarConversacion, renombrarConversacion, ocupado } = useCuestionario()
  const { encolar, renombrarGrupo, cancelarGrupo } = useSubidas()
  const conProblema = archivos.filter((archivo) => archivo.estado === 'con_problema').length
  const enProceso = archivos.filter((archivo) => archivo.estado === 'en_proceso').length
  const [modo, setModo] = useState<Modo>('ver')
  // Los sueltos se ven de entrada: son pocos y no hay un resumen que los cuente mejor.
  const [abierta, setAbierta] = useState(conProblema > 0 || grupo === null)
  const [quitando, setQuitando] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [nombre, setNombre] = useState(grupo ?? '')
  const [error, setError] = useState<string | null>(null)
  const [errores, setErrores] = useState<Record<string, string>>({})
  const selector = useRef<HTMLInputElement>(null)
  const campoNombre = useRef<HTMLInputElement>(null)
  const pregunta = useRef<HTMLParagraphElement>(null)
  const botonNombre = useRef<HTMLButtonElement>(null)
  const botonQuitar = useRef<HTMLButtonElement>(null)
  const id = useId()
  const idTitulo = `${id}titulo`
  const idLista = `${id}lista`
  const idNombre = `${id}nombre`
  const idError = `${id}error`
  const idPregunta = `${id}pregunta`

  const deshabilitado = bloqueado || ocupado || quitando !== null || guardando
  const titulo = grupo ?? (variante === 'material' ? 'Otros archivos' : 'Capturas y archivos sueltos')

  useEffect(() => {
    // Una nota nueva (volvió de leer con un problema) tiene que quedar a la vista.
    if (conProblema > 0) setAbierta(true)
  }, [conProblema])

  useEffect(() => {
    if (modo === 'nombre') campoNombre.current?.select()
    // El foco va a la pregunta: un lector de pantalla la lee antes de llegar a «Sí, quitar».
    if (modo === 'quitar') pregunta.current?.focus()
  }, [modo])

  function cerrar(devolverFocoA: RefObject<HTMLButtonElement | null>) {
    setModo('ver')
    setError(null)
    // Al cerrar, el foco vuelve al botón que lo abrió y no se pierde en la página.
    window.setTimeout(() => devolverFocoA.current?.focus(), 0)
  }

  async function quitarUno(archivo: ArchivoPublico) {
    setQuitando(archivo.id)
    setErrores(({ [archivo.id]: _anterior, ...resto }) => resto)
    const resultado = await quitarArchivo(archivo.id)
    setQuitando(null)
    if (!resultado.ok) setErrores((actuales) => ({ ...actuales, [archivo.id]: resultado.error }))
  }

  async function quitarTodo() {
    setQuitando('todo')
    setError(null)
    const resultado = await quitarConversacion(grupo)
    setQuitando(null)
    if (!resultado.ok) {
      setError(resultado.error)
      return
    }
    // Lo que había quedado por reintentar de esta conversación ya no tiene dónde ir.
    cancelarGrupo(grupo)
    onQuitada()
  }

  async function guardarNombre() {
    if (grupo === null || guardando) return
    const nuevo = sanearGrupo(nombre)
    if (!nuevo) {
      setError('Escribí un nombre para la conversación.')
      campoNombre.current?.focus()
      return
    }
    if (nuevo === grupo) return cerrar(botonNombre)
    if (otrosGrupos.some((otro) => otro.toLocaleLowerCase('es') === nuevo.toLocaleLowerCase('es'))) {
      setError('Ya hay otra conversación con ese nombre. Ponele uno distinto.')
      campoNombre.current?.focus()
      return
    }
    setGuardando(true)
    setError(null)
    const resultado = await renombrarConversacion(grupo, nuevo)
    setGuardando(false)
    if (!resultado.ok) {
      setError(resultado.error)
      return
    }
    // Lo que falta subir o reintentar de esta conversación va al nombre nuevo.
    renombrarGrupo(grupo, nuevo)
    cerrar(botonNombre)
  }

  function agregar(elegidos: File[]) {
    // A una conversación elegida va todo, también un .zip. Sin conversación, el .zip arma la suya.
    encolar(elegidos.map((archivo) => ({ archivo, grupo, grupoElegido: grupo !== null, esChat: false })))
  }

  return (
    <article className="conversacion" aria-labelledby={idTitulo}>
      <header className="conversacion-cabeza">
        {grupo === null ? (
          <IconoCarpeta className="conversacion-icono" />
        ) : (
          <IconoChat className="conversacion-icono" />
        )}
        <div className="conversacion-titulos">
          <h3 className="conversacion-nombre" id={idTitulo}>
            {titulo}
          </h3>
          <p className="conversacion-resumen">{resumenDe(archivos)}</p>
        </div>
      </header>

      {grupo === null && variante === 'material' && (
        <p className="conversacion-nota">
          Listas de precios, guiones o catálogos que no son de una conversación.
        </p>
      )}
      {enProceso > 0 && (
        <p className="conversacion-nota">
          <span className="girando" aria-hidden="true" />
          {enProceso === 1
            ? 'Todavía estamos escuchando 1 archivo.'
            : `Todavía estamos escuchando ${enProceso} archivos.`}
        </p>
      )}
      {conProblema > 0 && (
        <p className="conversacion-nota conversacion-nota-problema">
          {conProblema === 1
            ? '1 archivo no se pudo leer: mirá la nota abajo.'
            : `${conProblema} archivos no se pudieron leer: mirá las notas abajo.`}
        </p>
      )}
      {mismaQue && (
        <p className="conversacion-nota conversacion-nota-problema">
          Parece la misma conversación que «{mismaQue}». Si la subiste dos veces, quitá una.
        </p>
      )}

      {modo === 'ver' && (
        <div className="conversacion-acciones">
          <button
            type="button"
            className="boton boton-texto"
            aria-expanded={abierta}
            aria-controls={abierta ? idLista : undefined}
            onClick={() => setAbierta((ahora) => !ahora)}
          >
            {abierta ? 'Ocultar archivos' : `Ver archivos (${archivos.length})`}
          </button>
          <button
            type="button"
            className="boton boton-texto"
            onClick={() => selector.current?.click()}
            // Con subidas propias en curso se pueden sumar más; lo que frena es otra cosa en camino.
            disabled={ocupado && !bloqueado}
            aria-label={`Agregar archivos a ${titulo}`}
          >
            Agregar
          </button>
          {grupo !== null && (
            <button
              ref={botonNombre}
              type="button"
              className="boton boton-texto"
              onClick={() => {
                setNombre(grupo)
                setModo('nombre')
              }}
              disabled={deshabilitado}
              aria-label={`Cambiar el nombre de ${titulo}`}
            >
              Cambiar nombre
            </button>
          )}
          <button
            ref={botonQuitar}
            type="button"
            className="boton boton-texto"
            onClick={() => setModo('quitar')}
            disabled={deshabilitado}
            aria-label={grupo === null ? `Quitar todos los de ${titulo}` : `Quitar la conversación ${titulo}`}
          >
            {grupo === null ? 'Quitar todos' : 'Quitar'}
          </button>
        </div>
      )}

      {modo === 'nombre' && (
        <div className="conversacion-formulario" role="group" aria-label={`Cambiar el nombre de ${titulo}`}>
          <div className="campo">
            <label className="campo-etiqueta" htmlFor={idNombre}>
              Nombre de la conversación
            </label>
            <input
              ref={campoNombre}
              id={idNombre}
              className="entrada-texto"
              type="text"
              value={nombre}
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={error !== null}
              aria-describedby={error ? idError : undefined}
              onChange={(evento) => {
                setNombre(evento.target.value)
                setError(null)
              }}
              onKeyDown={(evento) => {
                if (evento.key === 'Enter') {
                  // Sin esto, dentro del formulario del pedido de chat el Enter mandaría la pantalla.
                  evento.preventDefault()
                  void guardarNombre()
                }
                if (evento.key === 'Escape') cerrar(botonNombre)
              }}
            />
            {error && (
              <p className="campo-error" id={idError} role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="acciones">
            <Boton onClick={guardarNombre} enCurso={guardando}>
              Guardar
            </Boton>
            <Boton variante="texto" onClick={() => cerrar(botonNombre)} disabled={guardando}>
              Cancelar
            </Boton>
          </div>
        </div>
      )}

      {modo === 'quitar' && (
        <div className="conversacion-formulario" role="group" aria-labelledby={idPregunta}>
          <p ref={pregunta} id={idPregunta} tabIndex={-1}>
            {grupo === null ? '¿Quitar todos estos archivos?' : '¿Quitar la conversación entera?'}{' '}
            {archivos.length === 1 ? 'Se borra su único archivo.' : `Se borran sus ${archivos.length} archivos.`}
          </p>
          {error && (
            <p className="campo-error" role="alert">
              {error}
            </p>
          )}
          <div className="acciones">
            <Boton
              onClick={quitarTodo}
              enCurso={quitando === 'todo'}
              textoEnCurso="Quitando…"
              disabled={bloqueado || ocupado}
            >
              Sí, quitar
            </Boton>
            <Boton variante="secundario" onClick={() => cerrar(botonQuitar)} disabled={quitando === 'todo'}>
              No
            </Boton>
          </div>
        </div>
      )}

      {abierta && (
        <ul className="lista-archivos" id={idLista}>
          {archivos.map((archivo) => (
            <li key={archivo.id} className="archivo">
              <IconoDeArchivo archivo={archivo} />
              <div className="archivo-cuerpo">
                <span className="archivo-nombre" title={archivo.nombre}>
                  {archivo.nombre}
                </span>
                <span className="archivo-detalle">{detalleDe(archivo)}</span>
              </div>
              <button
                type="button"
                className="boton boton-texto archivo-accion"
                onClick={() => quitarUno(archivo)}
                disabled={deshabilitado}
                aria-label={`Quitar ${archivo.nombre}`}
              >
                {quitando === archivo.id ? 'Quitando…' : 'Quitar'}
              </button>
              {/* Las notas van abajo, a todo el ancho: al lado del botón, en el celular quedan en
                  una columna de tres palabras. */}
              {archivo.problema && <p className="archivo-problema archivo-nota">{archivo.problema}</p>}
              {errores[archivo.id] && (
                <p className="archivo-error archivo-nota" role="alert">
                  {errores[archivo.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Sin `accept`: así el celular ofrece fotos, videos y archivos. */}
      <input
        ref={selector}
        className="solo-lectores"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(evento) => {
          const elegidos = Array.from(evento.target.files ?? [])
          evento.target.value = ''
          agregar(elegidos)
        }}
      />
    </article>
  )
}
