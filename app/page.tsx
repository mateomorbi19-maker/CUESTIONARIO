'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Suspense,
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
  leerTokenGuardado,
} from '@/lib/cliente-api'

const PATRON_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Inicio. Se llega con el link general (`?c=`), volviendo sin link a un dispositivo donde ya se
 * empezó, o sin nada.
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

  if (codigo) return <FormularioInicio codigo={codigo} tokenGuardado={tokenGuardado ?? null} />
  if (tokenGuardado === undefined) return null
  if (tokenGuardado) return <Retomar token={tokenGuardado} />
  return <SinLink />
}

function rutaDe(token: string) {
  return `/c/${encodeURIComponent(token)}`
}

interface ErroresFormulario {
  negocio?: string
  email?: string
}

function FormularioInicio({ codigo, tokenGuardado }: { codigo: string; tokenGuardado: string | null }) {
  const router = useRouter()
  const id = useId()
  const campoNegocio = useRef<HTMLInputElement>(null)
  const campoEmail = useRef<HTMLInputElement>(null)
  const [negocio, setNegocio] = useState('')
  const [email, setEmail] = useState('')
  const [errores, setErrores] = useState<ErroresFormulario>({})
  const [errorServidor, setErrorServidor] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

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
      const { token, url } = await crearCuestionario(datos)
      guardarToken(token)
      // La url la arma nuestro servidor, pero router.push ejecutaría un «javascript:»: solo rutas propias.
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

  const idNegocio = `${id}negocio`
  const idEmail = `${id}email`

  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Contanos cómo vendés hoy</h1>
        <p>
          Son preguntas sobre cómo atendés los chats de tu negocio. Podés cortar cuando quieras: se
          guarda todo y seguís con el mismo link.
        </p>
        <p className="inicio-duracion">Lleva alrededor de una hora, en partes.</p>
      </div>

      {tokenGuardado && (
        <p className="aviso">
          Ya empezaste un cuestionario en este dispositivo.{' '}
          <Link href={rutaDe(tokenGuardado)}>Seguir donde quedé</Link>
        </p>
      )}

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
            Te mandamos tu link personal, para seguir desde cualquier dispositivo.
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

function Retomar({ token }: { token: string }) {
  return (
    <main className="hoja tarjeta inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Tenés un cuestionario empezado</h1>
        <p>Lo que contestaste quedó guardado. Seguís desde donde lo dejaste.</p>
      </div>
      <div className="acciones">
        <Link className="boton boton-principal" href={rutaDe(token)}>
          Seguir donde quedé
        </Link>
      </div>
    </main>
  )
}

function SinLink() {
  return (
    <main className="hoja inicio">
      <div className="inicio-cabeza">
        <h1 className="inicio-titulo">Cuestionario de tu negocio</h1>
        <p>Este cuestionario se abre con el link que te pasaron.</p>
      </div>
    </main>
  )
}
