import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Cuestionario de tu negocio',
  description: 'Contanos cómo vendés hoy.',
  // Cada cuestionario es de un cliente: no tiene que aparecer en buscadores.
  robots: { index: false, follow: false },
  // El link personal da acceso al cuestionario: que no viaje a otros sitios en el Referer.
  referrer: 'same-origin',
  // iOS convierte en enlaces los números que parecen teléfonos; en precios y horarios citados
  // del material eso confunde.
  formatDetection: { telephone: false, address: false, email: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // El tono del fondo: en el celular la barra del navegador se funde con la página.
  themeColor: '#f4efe6',
  colorScheme: 'light',
}

export default function RaizLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
