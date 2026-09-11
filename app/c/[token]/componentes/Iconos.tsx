import type { ReactNode, SVGProps } from 'react'

type PropsIcono = SVGProps<SVGSVGElement>

// Trazos propios, sin paquetes de iconos. Todos son decorativos: el texto de al lado ya dice lo
// mismo, así que los lectores de pantalla los saltean.
function Icono({ children, ...props }: PropsIcono & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export function IconoCheck(props: PropsIcono) {
  return (
    <Icono {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icono>
  )
}

export function IconoFlecha(props: PropsIcono) {
  return (
    <Icono {...props}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Icono>
  )
}

export function IconoSubir(props: PropsIcono) {
  return (
    <Icono {...props}>
      <path d="M12 15V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Icono>
  )
}

export function IconoImagen(props: PropsIcono) {
  return (
    <Icono {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="M20.5 16l-4.5-4.5-8.5 8" />
    </Icono>
  )
}

export function IconoDocumento(props: PropsIcono) {
  return (
    <Icono {...props}>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9 13h6M9 16.5h4" />
    </Icono>
  )
}

export function IconoTexto(props: PropsIcono) {
  return (
    <Icono {...props}>
      <path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6" />
    </Icono>
  )
}
