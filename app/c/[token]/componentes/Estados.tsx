import { Boton } from './Boton'
import { MensajeError } from './Mensajes'
import { TextoConNegritas } from './TextoConNegritas'

/** Antes de la primera respuesta del servidor. */
export function Cargando() {
  return (
    <section className="cargando" role="status">
      <h1 className="solo-lectores">Cargando tu cuestionario</h1>
      {/* Aparece con demora (globals.css): si carga rápido, no hay parpadeo. */}
      <div className="esqueleto" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </section>
  )
}

/** El servidor no conoce el token: link cortado, mal copiado o inventado. */
export function LinkInvalido() {
  return (
    <section className="estado">
      <h1 className="estado-titulo" tabIndex={-1}>
        Este link no funciona
      </h1>
      <p>
        Puede que se haya cortado al copiarlo. Abrí de nuevo el link completo que te llegó por
        mail, o pedíselo a quien te lo pasó.
      </p>
    </section>
  )
}

interface PropsSinConexion {
  mensaje: string
  onReintentar: () => void
  reintentando: boolean
}

/** No se pudo leer el estado la primera vez. */
export function SinConexion({ mensaje, onReintentar, reintentando }: PropsSinConexion) {
  return (
    <section className="estado">
      <h1 className="estado-titulo" tabIndex={-1}>
        No pudimos abrir tu cuestionario
      </h1>
      <div className="mensaje-error" role="alert">
        <p>{mensaje}</p>
      </div>
      <p className="estado-nota">Lo que ya contestaste está guardado.</p>
      <div className="acciones">
        <Boton onClick={onReintentar} enCurso={reintentando} textoEnCurso="Probando…">
          Probar de nuevo
        </Boton>
      </div>
    </section>
  )
}

interface PropsFallo {
  /** El `error` del estado: por qué no terminó de procesarse. */
  mensaje: string
  /** Si el reintento tampoco se aceptó. */
  error: string | null
  onReintentar: () => void
  reintentando: boolean
}

/** El servidor aceptó la entrada pero no pudo procesarla. Se reintenta sin volver a escribir. */
export function FalloProceso({ mensaje, error, onReintentar, reintentando }: PropsFallo) {
  return (
    <section className="estado">
      <h1 className="estado-titulo" tabIndex={-1}>
        No se pudo terminar este paso
      </h1>
      <div className="aviso" role="alert">
        <TextoConNegritas texto={mensaje} />
      </div>
      <p>Lo que mandaste quedó guardado: al reintentar se usa eso, no hace falta escribir nada.</p>
      <MensajeError mensaje={error} />
      <div className="acciones">
        <Boton onClick={onReintentar} enCurso={reintentando} textoEnCurso="Reintentando…">
          Reintentar
        </Boton>
      </div>
    </section>
  )
}
