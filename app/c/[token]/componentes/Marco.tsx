import { useId, useRef, useState, type ReactNode } from 'react'
import { BarraDeProgreso } from './BarraDeProgreso'
import { Boton } from './Boton'
import { IconoCheck } from './Iconos'

interface Props {
  progreso: { porcentaje: number; texto: string } | null
  /** Hay un envío en camino: dice «Guardando…» hasta que el servidor lo acepta. */
  guardando?: boolean
  /** Cambia cada vez que algo se guarda bien: la marca de «Todo guardado» aparece de nuevo. */
  marcaGuardado?: number
  /** A qué mail le llegó el link para seguir. Lo dice «Seguir más tarde». */
  email?: string | null
  /** Aviso arriba de todo, como «Se actualizó desde otra pestaña». */
  aviso?: string | null
  /** Contenido centrado en el alto de la pantalla (el agradecimiento). */
  centrado?: boolean
  /** En la galería de /demo van muchas juntas: sin alto de pantalla completa ni <main>. */
  compacto?: boolean
  children: ReactNode
}

/**
 * Lo que rodea a cada pantalla. Arriba y siempre a la vista, que está todo guardado y cómo seguir
 * más tarde: en un formulario largo la duda más común es si se puede cerrar sin perder nada.
 */
export function Marco({
  progreso,
  guardando = false,
  marcaGuardado = 0,
  email = null,
  aviso = null,
  centrado = false,
  compacto = false,
  children,
}: Props) {
  const Hoja = compacto ? 'div' : 'main'
  const clases = ['pagina', centrado && 'pagina-centrada', compacto && 'pagina-compacta']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={clases}>
      {progreso && (
        <header className="cabecera">
          <div className="cabecera-fila">
            {/* La región está siempre: los lectores de pantalla anuncian cuando cambia lo de adentro. */}
            <p className="guardado" aria-live="polite">
              {guardando ? (
                'Guardando…'
              ) : (
                // La key vuelve a animar la marca con cada guardado: se nota que acaba de pasar.
                <span key={marcaGuardado} className="guardado-marca">
                  <IconoCheck width={18} height={18} />
                  Todo guardado
                </span>
              )}
            </p>
            <SeguirMasTarde email={email} />
          </div>
          <BarraDeProgreso porcentaje={progreso.porcentaje} texto={progreso.texto} />
        </header>
      )}
      <Hoja className="hoja">
        {aviso && (
          <p className="aviso aviso-arriba" role="status">
            {aviso}
          </p>
        )}
        {children}
      </Hoja>
    </div>
  )
}

/** Dice que puede cerrar sin perder nada y cómo vuelve a entrar. */
function SeguirMasTarde({ email }: { email: string | null }) {
  const dialogo = useRef<HTMLDialogElement>(null)
  const idTitulo = useId()
  const [copiado, setCopiado] = useState(false)
  // Donde el navegador no deja escribir en el portapapeles, el link queda a la vista para copiarlo.
  const [linkAMano, setLinkAMano] = useState<string | null>(null)

  async function copiar() {
    const link = window.location.href
    try {
      await navigator.clipboard.writeText(link)
      setCopiado(true)
    } catch {
      setLinkAMano(link)
    }
  }

  function abrir() {
    setCopiado(false)
    dialogo.current?.showModal()
  }

  return (
    <>
      <Boton variante="secundario" className="boton-compacto" onClick={abrir}>
        Seguir más tarde
      </Boton>
      <dialog ref={dialogo} className="dialogo" aria-labelledby={idTitulo}>
        <span className="dialogo-marca" aria-hidden="true">
          <IconoCheck width={26} height={26} />
        </span>
        <h2 className="dialogo-titulo" id={idTitulo}>
          Tu progreso está guardado
        </h2>
        <p>
          Podés cerrar esta página. Para seguir, abrí el link que te mandamos
          {email ? (
            <>
              {' '}a <strong>{email}</strong>
            </>
          ) : (
            ' por mail'
          )}
          : te lleva a la pregunta donde quedaste, en el celular o en la compu.
        </p>
        <p className="dialogo-nota">
          Lo que escribiste y todavía no mandaste queda guardado solo en este dispositivo.
        </p>
        {linkAMano && (
          <input
            className="entrada-texto"
            readOnly
            value={linkAMano}
            aria-label="Tu link para seguir"
            onFocus={(evento) => evento.target.select()}
          />
        )}
        <div className="acciones">
          <Boton onClick={copiar}>{copiado ? 'Link copiado' : 'Copiar mi link'}</Boton>
          <Boton variante="secundario" onClick={() => dialogo.current?.close()}>
            Seguir respondiendo
          </Boton>
        </div>
      </dialog>
    </>
  )
}
