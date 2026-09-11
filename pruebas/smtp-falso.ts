import { createServer, type AddressInfo, type Socket } from 'node:net'

/**
 * Servidor SMTP falso, con lo mínimo para que el cliente complete un envío.
 *
 * Escucha en 127.0.0.1 y en un puerto que elige el sistema: no choca con nada ni sale a la red.
 * Por eso las pruebas usan SMTP_TLS=ninguno, que solo se acepta contra un host local.
 */
export interface ServidorFalso {
  puerto: number
  /** Cada línea que llegó fuera del DATA, en orden. Incluye usuario y clave de AUTH LOGIN. */
  comandos: string[]
  /** Lo que llegó en cada DATA, sin el punto final. */
  mensajes: string[]
  conexiones: number
  cerrar(): Promise<void>
}

export interface OpcionesServidor {
  /** Respuesta al RCPT TO en lugar del 250. */
  rcpt?: string
  /** Cierra la conexión, sin responder, al recibir este comando. */
  cortarEn?: string
}

export async function levantarServidor(opciones: OpcionesServidor = {}): Promise<ServidorFalso> {
  const abiertos = new Set<Socket>()
  const servidor: ServidorFalso = {
    puerto: 0,
    comandos: [],
    mensajes: [],
    conexiones: 0,
    cerrar: async () => {
      for (const socket of abiertos) socket.destroy()
      await new Promise<void>((resolver) => tcp.close(() => resolver()))
    },
  }

  const tcp = createServer((socket) => {
    servidor.conexiones++
    abiertos.add(socket)
    socket.on('close', () => abiertos.delete(socket))
    socket.on('error', () => undefined)

    const responder = (...lineas: string[]) => socket.write(lineas.map((linea) => `${linea}\r\n`).join(''))
    let pendiente = ''
    let enDatos = false
    let pasoAuth: 'usuario' | 'clave' | null = null

    responder('220 falso.test ESMTP listo')
    socket.on('data', (trozo: Buffer) => {
      pendiente += trozo.toString('latin1')
      while (true) {
        if (enDatos) {
          const fin = pendiente.indexOf('\r\n.\r\n')
          if (fin === -1) return
          servidor.mensajes.push(pendiente.slice(0, fin).replace(/^\.\./gm, '.'))
          pendiente = pendiente.slice(fin + 5)
          enDatos = false
          responder('250 2.0.0 Recibido')
          continue
        }

        const salto = pendiente.indexOf('\r\n')
        if (salto === -1) return
        const linea = pendiente.slice(0, salto)
        pendiente = pendiente.slice(salto + 2)
        servidor.comandos.push(linea)
        const verbo = linea.split(' ')[0].toUpperCase()

        if (verbo === opciones.cortarEn) {
          socket.end()
          return
        }
        if (pasoAuth === 'usuario') {
          pasoAuth = 'clave'
          responder('334 UGFzc3dvcmQ6')
        } else if (pasoAuth === 'clave') {
          pasoAuth = null
          responder('235 2.7.0 Autenticado')
        } else if (verbo === 'EHLO') {
          responder('250-falso.test', '250-AUTH LOGIN', '250-SIZE 26214400', '250 8BITMIME')
        } else if (linea === 'AUTH LOGIN') {
          pasoAuth = 'usuario'
          responder('334 VXNlcm5hbWU6')
        } else if (verbo === 'MAIL') {
          responder('250 2.1.0 OK')
        } else if (verbo === 'RCPT') {
          responder(opciones.rcpt ?? '250 2.1.5 OK')
        } else if (verbo === 'DATA') {
          enDatos = true
          responder('354 Mandá el mensaje y terminá con un punto solo')
        } else if (verbo === 'QUIT') {
          responder('221 2.0.0 Chau')
          socket.end()
          return
        } else {
          responder('502 5.5.2 No entiendo')
        }
      }
    })
  })

  await new Promise<void>((resolver) => tcp.listen(0, '127.0.0.1', resolver))
  servidor.puerto = (tcp.address() as AddressInfo).port
  return servidor
}

/** El texto legible de un mail tal como llegó: el cuerpo viaja en base64 (ver lib/correo.ts). */
export function textoDelMail(crudo: string): string {
  return crudo
    .split('\r\n\r\n')
    .filter((bloque) => /^[A-Za-z0-9+/=\r\n]+$/.test(bloque.trim()))
    .map((bloque) => Buffer.from(bloque.replace(/\r\n/g, ''), 'base64').toString('utf8'))
    .join('\n')
}
