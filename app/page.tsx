'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ErrorApi,
  crearCuestionario,
  escucharAlmacen,
  guardarToken,
  leerEstado,
  leerTokenGuardado,
  olvidarToken,
} from '@/lib/cliente-api'
import type { EstadoPublico } from '@/lib/estado-publico'
import { BarraDeProgreso } from './c/[token]/componentes/BarraDeProgreso'
import { IconoCheck } from './c/[token]/componentes/Iconos'

const PATRON_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Inicio. Se llega con el link general (`?c=`), volviendo a un dispositivo donde ya se empezó, o
 * sin nada. Hay una sola cosa para hacer a la vista: empezar, o seguir donde quedó.
 */
export default function Inicio() {
  return (
    <div className="pagina pagina-inicio">
      {/* useSearchParams necesita un Suspense arriba para que la página se pueda prerenderizar. */}
      <Suspense fallback={null}>
        <ContenidoInicio />
      </Suspense>
    </div>
  )
}

// En el servidor no hay localStorage: undefined quiere decir «todavía no se sabe».
const sinTokenEnServidor = () => undefined

function ContenidoInicio() {
  const codigo = useSearchParams().get('c')?.trim() || null
  const tokenGuardado = useSyncExternalStore<string | null | undefined>(
    escucharAlmacen,
    leerTokenGuardado,
    sinTokenEnServidor,
  )
  // El evento storage solo avisa de cambios hechos en otras pestañas: lo que se deja de lado en
  // esta (terminado, link que ya no existe o «empezar uno nuevo») se recuerda acá.
  const [descartado, setDescartado] = useState<string | null>(null)

  if (tokenGuardado === undefined) return null
  const token = tokenGuardado && tokenGuardado !== descartado ? tokenGuardado : null

  if (token) {
    return (
      <Empezado
        key={token}
        token={token}
        // Sin el código del link general no se puede abrir otro: el botón no tendría a dónde ir.
        puedeEmpezarOtro={codigo !== null}
        onDescartar={setDescartado}
      />
    )
  }
  if (codigo) return <FormularioInicio codigo={codigo} />
  return <SinLink />
}

function rutaDe(token: string) {
  return `/c/${encodeURIComponent(token)}`
}

interface PropsEmpezado {
  token: string
  puedeEmpezarOtro: boolean
  onDescartar: (token: string) => void
}

/** Ya hay uno empezado en este dispositivo: lo primero es seguirlo, no abrir otro. */
function Empezado({ token, puedeEmpezarOtro, onDescartar }: PropsEmpezado) {
  const [estado, setEstado] = useState<EstadoPublico | null>(null)

  useEffect(() => {
    let vigente = true
    leerEstado(token)
      .then((leido) => {
        if (!vigente) return
        if (leido.etapa !== 'terminado') {
          setEstado(leido)
          return
        }
        olvidarToken(token)
        onDescartar(token)
      })
      .catch((err: unknown) => {
        // Sin conexión igual se puede tocar «Seguir»: la pantalla del cuestionario sabe reintentar.
        if (!vigente || !(err instanceof ErrorApi) || err.estado !== 404) return
        olvidarToken(token)
        onDescartar(token)
      })
    return () => {
      vigente = false
    }
  }, [token, onDescartar])

  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Tenés un cuestionario empezado</h1>
        <p>Todo lo que contestaste está guardado. Seguís desde la pregunta donde quedaste.</p>
      </div>

      {estado && (
        <div className="empezado">
          <p className="empezado-negocio">{estado.negocio}</p>
          <BarraDeProgreso porcentaje={estado.progreso.porcentaje} texto={estado.progreso.texto} />
        </div>
      )}

      <div className="acciones">
        <Link className="boton boton-principal" href={rutaDe(token)}>
          Seguir donde quedé
        </Link>
      </div>

      {puedeEmpezarOtro && (
        <button
          type="button"
          className="boton boton-texto boton-chico"
          onClick={() => onDescartar(token)}
        >
          Empezar un cuestionario nuevo
        </button>
      )}
    </main>
  )
}

interface ErroresFormulario {
  negocio?: string
  email?: string
}

function FormularioInicio({ codigo }: { codigo: string }) {
  const router = useRouter()
  const id = useId()
  const campoNegocio = useRef<HTMLInputElement>(null)
  const campoEmail = useRef<HTMLInputElement>(null)
  const [negocio, setNegocio] = useState('')
  const [email, setEmail] = useState('')
  const [errores, setErrores] = useState<ErroresFormulario>({})
  const [errorServidor, setErrorServidor] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [linkEnviadoA, setLinkEnviadoA] = useState<string | null>(null)

  async function empezar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    if (enviando) return

    const datos = { codigo, negocio: negocio.trim(), email: email.trim() }
    const nuevos: ErroresFormulario = {}
    if (!datos.negocio) nuevos.negocio = 'Escribí el nombre de tu negocio.'
    if (!datos.email) nuevos.email = 'Escribí tu mail.'
    else if (!PATRON_MAIL.test(datos.email)) {
      nuevos.email = 'Revisá el mail: parece que le falta algo (tiene que ser como nombre@dominio.com).'
    }
    setErrores(nuevos)
    setErrorServidor(null)
    if (nuevos.negocio) {
      campoNegocio.current?.focus()
      return
    }
    if (nuevos.email) {
      campoEmail.current?.focus()
      return
    }

    setEnviando(true)
    try {
      const resultado = await crearCuestionario(datos)
      if ('retomado' in resultado) {
        setLinkEnviadoA(resultado.email)
        setEnviando(false)
        return
      }
      guardarToken(resultado.token)
      // La url la arma nuestro servidor, pero router.push ejecutaría un «javascript:»: solo rutas propias.
      const { url, token } = resultado
      router.push(url.startsWith('/') && !url.startsWith('//') ? url : rutaDe(token))
      // «enviando» queda prendido a propósito: un segundo toque durante la navegación crearía
      // otro cuestionario.
    } catch (err) {
      setErrorServidor(
        err instanceof ErrorApi ? err.message : 'No se pudo crear el cuestionario. Probá de nuevo.',
      )
      setEnviando(false)
    }
  }

  function pasarAlMail(evento: KeyboardEvent<HTMLInputElement>) {
    // Enter en el primer campo lleva al segundo: enviar con el mail vacío mostraría un error de golpe.
    if (evento.key !== 'Enter' || evento.nativeEvent.isComposing) return
    evento.preventDefault()
    campoEmail.current?.focus()
  }

  if (linkEnviadoA) return <LinkEnviado email={linkEnviadoA} />

  const idNegocio = `${id}negocio`
  const idEmail = `${id}email`

  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Contanos cómo vendés hoy</h1>
        <p>Son preguntas sobre cómo atendés hoy los chats de tu negocio.</p>
      </div>

      <ul className="garantias">
        <li>
          <IconoCheck />
          Se guarda solo, respuesta por respuesta.
        </li>
        <li>
          <IconoCheck />
          Podés cerrar y seguir cuando quieras, desde el celular o la compu.
        </li>
        <li>
          <IconoCheck />
          Lleva alrededor de una hora, en partes.
        </li>
      </ul>

      <form className="formulario" noValidate onSubmit={empezar}>
        <div className="campo">
          <label className="campo-etiqueta" htmlFor={idNegocio}>
            Nombre del negocio
          </label>
          <input
            ref={campoNegocio}
            id={idNegocio}
            className="entrada-texto"
            type="text"
            value={negocio}
            onChange={(evento) => setNegocio(evento.target.value)}
            onKeyDown={pasarAlMail}
            autoComplete="organization"
            enterKeyHint="next"
            aria-invalid={errores.negocio ? true : undefined}
            aria-describedby={errores.negocio ? `${idNegocio}-error` : undefined}
          />
          {errores.negocio && (
            <p className="campo-error" id={`${idNegocio}-error`}>
              {errores.negocio}
            </p>
          )}
        </div>

        <div className="campo">
          <label className="campo-etiqueta" htmlFor={idEmail}>
            Tu mail
          </label>
          <p className="campo-ayuda" id={`${idEmail}-ayuda`}>
            Ahí te llega el link para seguir. Si ya empezaste antes, poné el mismo mail.
          </p>
          <input
            ref={campoEmail}
            id={idEmail}
            className="entrada-texto"
            type="email"
            inputMode="email"
            value={email}
            onChange={(evento) => setEmail(evento.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={errores.email ? true : undefined}
            aria-describedby={[`${idEmail}-ayuda`, errores.email ? `${idEmail}-error` : null]
              .filter(Boolean)
              .join(' ')}
          />
          {errores.email && (
            <p className="campo-error" id={`${idEmail}-error`}>
              {errores.email}
            </p>
          )}
        </div>

        {errorServidor && (
          <div className="mensaje-error" role="alert">
            <p>{errorServidor}</p>
          </div>
        )}

        <div className="acciones">
          <button
            type="submit"
            className="boton boton-principal"
            disabled={enviando}
            aria-busy={enviando || undefined}
          >
            {enviando ? 'Preparando tu cuestionario…' : 'Empezar'}
          </button>
        </div>
      </form>
    </main>
  )
}

/** Ese mail ya tenía uno sin terminar: no se abrió otro, se le mandó el link para seguirlo. */
function LinkEnviado({ email }: { email: string }) {
  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <span className="inicio-marca" aria-hidden="true">
          <IconoCheck width={28} height={28} />
        </span>
        <h1 className="inicio-titulo">Ya tenías un cuestionario empezado</h1>
        <p>
          Te mandamos el link a <strong>{email}</strong> para que sigas desde la pregunta donde
          quedaste. Está todo guardado.
        </p>
        <p className="inicio-nota">Si en unos minutos no lo ves, revisá la carpeta de spam.</p>
      </div>
    </main>
  )
}

function SinLink() {
  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Cuestionario de tu negocio</h1>
        <p>Para empezar, abrí el link que te pasaron.</p>
        <p className="inicio-nota">
          Si ya empezaste, abrí el link que te llegó por mail: seguís desde donde quedaste.
        </p>
      </div>
    </main>
  )
}
