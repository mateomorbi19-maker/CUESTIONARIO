import { useEffect, useId, useRef, useState, type DragEvent as ArrastreReact } from 'react'
import { TIPOS_ACEPTADOS, problemaDeArchivo } from '@/lib/cliente-api'
import { Boton } from './Boton'
import { useCuestionario } from './Contexto'
import { IconoSubir } from './Iconos'

interface Pendiente {
  clave: number
  nombre: string
  estado: 'en_fila' | 'subiendo' | 'error'
  error: string | null
}

interface Props {
  textoBoton: string
  ayuda?: string
  /** Zona para arrastrar y soltar. Se ve solo con mouse; en el celular queda el botón. */
  arrastrable?: boolean
  /** Avisa si hay archivos subiendo o en fila: mientras tanto no conviene seguir. */
  onSubiendo: (subiendo: boolean) => void
}

/**
 * Elegir o soltar archivos y verlos subir. Cuando uno termina desaparece de acá: ya está en la
 * lista que devuelve el servidor (ListaDeMaterial).
 */
export function SubidaDeArchivos({ textoBoton, ayuda, arrastrable = false, onSubiendo }: Props) {
  const { subirArchivo, ocupado } = useCuestionario()
  const selector = useRef<HTMLInputElement>(null)
  const cola = useRef<Promise<void>>(Promise.resolve())
  const contador = useRef(0)
  const [pendientes, setPendientes] = useState<Pendiente[]>([])
  const [arrastrando, setArrastrando] = useState(false)
  const idAyuda = useId()

  const activos = pendientes.some((pendiente) => pendiente.estado !== 'error')
  // Con subidas propias en curso se pueden sumar más; lo que bloquea es otra cosa en camino.
  const bloqueado = ocupado && !activos

  useEffect(() => {
    onSubiendo(activos)
  }, [activos, onSubiendo])

  useEffect(() => {
    if (!arrastrable) return
    // Si el archivo cae fuera de la zona, el navegador lo abre y el cliente sale del cuestionario.
    function evitarQueSeAbra(evento: DragEvent) {
      if (evento.dataTransfer?.types.includes('Files')) evento.preventDefault()
    }
    window.addEventListener('dragover', evitarQueSeAbra)
    window.addEventListener('drop', evitarQueSeAbra)
    return () => {
      window.removeEventListener('dragover', evitarQueSeAbra)
      window.removeEventListener('drop', evitarQueSeAbra)
    }
  }, [arrastrable])

  function actualizar(clave: number, cambios: Partial<Pendiente>) {
    setPendientes((lista) =>
      lista.map((pendiente) => (pendiente.clave === clave ? { ...pendiente, ...cambios } : pendiente)),
    )
  }

  function descartar(clave: number) {
    setPendientes((lista) => lista.filter((pendiente) => pendiente.clave !== clave))
  }

  function agregar(archivos: File[]) {
    if (archivos.length === 0 || bloqueado) return

    const nuevos = archivos.map((archivo) => {
      const problema = problemaDeArchivo(archivo)
      const pendiente: Pendiente = {
        clave: ++contador.current,
        nombre: archivo.name,
        estado: problema ? 'error' : 'en_fila',
        error: problema,
      }
      return { archivo, pendiente }
    })
    setPendientes((lista) => [...lista, ...nuevos.map(({ pendiente }) => pendiente)])

    for (const { archivo, pendiente } of nuevos) {
      if (pendiente.estado === 'error') continue
      // De a uno y en orden: cada subida devuelve el estado entero y dos a la vez podrían pisarse.
      cola.current = cola.current.then(async () => {
        actualizar(pendiente.clave, { estado: 'subiendo' })
        try {
          const resultado = await subirArchivo(archivo)
          if (resultado.ok) descartar(pendiente.clave)
          else actualizar(pendiente.clave, { estado: 'error', error: resultado.error })
        } catch {
          actualizar(pendiente.clave, {
            estado: 'error',
            error: `«${archivo.name}» no se subió. Probá elegirlo de nuevo.`,
          })
        }
      })
    }
  }

  function tieneArchivos(evento: ArrastreReact<HTMLElement>) {
    return evento.dataTransfer.types.includes('Files')
  }

  function alEntrar(evento: ArrastreReact<HTMLDivElement>) {
    if (!tieneArchivos(evento)) return
    evento.preventDefault()
    setArrastrando(true)
  }

  function alPasar(evento: ArrastreReact<HTMLDivElement>) {
    if (!tieneArchivos(evento)) return
    evento.preventDefault()
    evento.dataTransfer.dropEffect = bloqueado ? 'none' : 'copy'
  }

  function alSalir(evento: ArrastreReact<HTMLDivElement>) {
    // dragleave también salta al pasar por encima de un hijo: solo cuenta si salió de la zona.
    if (!evento.currentTarget.contains(evento.relatedTarget as Node | null)) setArrastrando(false)
  }

  function alSoltar(evento: ArrastreReact<HTMLDivElement>) {
    evento.preventDefault()
    setArrastrando(false)
    agregar(Array.from(evento.dataTransfer.files))
  }

  const clasesZona = [
    'subida-zona',
    arrastrable && 'subida-zona-arrastrable',
    arrastrando && 'subida-zona-activa',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="subida">
      <div
        className={clasesZona}
        onDragEnter={arrastrable ? alEntrar : undefined}
        onDragOver={arrastrable ? alPasar : undefined}
        onDragLeave={arrastrable ? alSalir : undefined}
        onDrop={arrastrable ? alSoltar : undefined}
      >
        {arrastrable && (
          <p className="subida-arrastrar" aria-hidden="true">
            Arrastrá los archivos acá o
          </p>
        )}
        <Boton
          variante="secundario"
          onClick={() => selector.current?.click()}
          disabled={bloqueado}
          aria-describedby={ayuda ? idAyuda : undefined}
        >
          <IconoSubir />
          {textoBoton}
        </Boton>
        {ayuda && (
          <p className="subida-ayuda" id={idAyuda}>
            {ayuda}
          </p>
        )}
        <input
          ref={selector}
          className="solo-lectores"
          type="file"
          multiple
          accept={TIPOS_ACEPTADOS}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(evento) => {
            agregar(Array.from(evento.target.files ?? []))
            // Sin esto, volver a elegir el mismo archivo (después de un error) no dispara el cambio.
            evento.target.value = ''
          }}
        />
      </div>

      {pendientes.length > 0 && (
        <ul className="lista-archivos" aria-live="polite">
          {pendientes.map((pendiente) => (
            <li
              key={pendiente.clave}
              className={pendiente.estado === 'error' ? 'archivo archivo-con-error' : 'archivo'}
            >
              {pendiente.estado === 'error' ? (
                <span className="archivo-marca-error" aria-hidden="true">
                  !
                </span>
              ) : (
                <span className="girando archivo-girando" aria-hidden="true" />
              )}
              <div className="archivo-cuerpo">
                <span className="archivo-nombre">{pendiente.nombre}</span>
                {pendiente.estado === 'error' ? (
                  <span className="archivo-error" role="alert">
                    {pendiente.error}
                  </span>
                ) : (
                  <span className="archivo-detalle">
                    {pendiente.estado === 'subiendo' ? 'Subiendo…' : 'En fila'}
                  </span>
                )}
              </div>
              {pendiente.estado === 'error' && (
                <button
                  type="button"
                  className="boton boton-texto archivo-accion"
                  onClick={() => descartar(pendiente.clave)}
                  aria-label={`Cerrar el aviso de ${pendiente.nombre}`}
                >
                  Cerrar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
