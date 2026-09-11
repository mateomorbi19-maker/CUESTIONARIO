import type { ComponentPropsWithRef } from 'react'

interface Props extends ComponentPropsWithRef<'button'> {
  variante?: 'principal' | 'secundario' | 'texto'
  /** Bloquea el botón y muestra `textoEnCurso` mientras se guarda lo que mandó. */
  enCurso?: boolean
  textoEnCurso?: string
}

export function Boton({
  variante = 'principal',
  enCurso = false,
  textoEnCurso = 'Guardando…',
  // Dentro de un formulario un <button> sin tipo envía: mejor que enviar sea siempre explícito.
  type = 'button',
  className,
  disabled,
  children,
  ...resto
}: Props) {
  return (
    <button
      {...resto}
      type={type}
      className={['boton', `boton-${variante}`, className].filter(Boolean).join(' ')}
      disabled={disabled || enCurso}
      aria-busy={enCurso || undefined}
    >
      {enCurso ? textoEnCurso : children}
    </button>
  )
}
