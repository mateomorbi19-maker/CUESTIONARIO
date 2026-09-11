import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { beforeEach, describe, it } from 'node:test'
import { configuracionCorreo, enviarCorreo, ErrorCorreo, faltaParaCorreo } from '../lib/correo'

/**
 * Servidor SMTP falso, con lo mínimo para que el cliente complete un envío.
 *
 * Escucha en 127.0.0.1 y en un puerto que elige el sistema: no choca con nada ni sale a la red.
 * Por eso las pruebas usan SMTP_TLS=ninguno, que solo se acepta contra un host local.
 */
interface ServidorFalso {
  puerto: number
  /** Cada línea que llegó fuera del DATA, en orden. Incluye usuario y clave de AUTH LOGIN. */
  comandos: string[]
  /** Lo que llegó en cada DATA, sin el punto final. */
  mensajes: string[]
  conexiones: number
  cerrar(): Promise<void>
}

interface OpcionesServidor {
  /** Respuesta al RCPT TO en lugar del 250. */
  rcpt?: string
  /** Cierra la conexión, sin responder, al recibir este comando. */
  cortarEn?: string
}

async function levantarServidor(opciones: OpcionesServidor = {}): Promise<ServidorFalso> {
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

const VARIABLES = ['SMTP_HOST', 'SMTP_PUERTO', 'SMTP_USUARIO', 'SMTP_CLAVE', 'SMTP_REMITENTE', 'SMTP_TLS']
const REMITENTE = 'avisos@cuestionario.test'
const DESTINO = 'mateo@ejemplo.test'

// Cada prueba arma su configuración desde cero: lo que deja una no puede cambiar la siguiente.
beforeEach(() => {
  for (const nombre of VARIABLES) delete process.env[nombre]
})

async function conServidor(opciones: OpcionesServidor, prueba: (servidor: ServidorFalso) => Promise<void>) {
  const servidor = await levantarServidor(opciones)
  try {
    Object.assign(process.env, {
      SMTP_HOST: '127.0.0.1',
      SMTP_PUERTO: String(servidor.puerto),
      SMTP_REMITENTE: REMITENTE,
      SMTP_TLS: 'ninguno',
    })
    await prueba(servidor)
  } finally {
    await servidor.cerrar()
  }
}

interface Parte {
  cabeceras: Map<string, string>
  cuerpo: string
}

/** Separa cabeceras y cuerpo, y junta las cabeceras partidas en varias líneas. */
function separar(crudo: string): Parte {
  const corte = crudo.indexOf('\r\n\r\n')
  assert.notEqual(corte, -1, 'no hay línea en blanco entre cabeceras y cuerpo')
  const cabeceras = new Map<string, string>()
  for (const linea of crudo.slice(0, corte).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const dosPuntos = linea.indexOf(':')
    cabeceras.set(linea.slice(0, dosPuntos).toLowerCase(), linea.slice(dosPuntos + 1).trim())
  }
  return { cabeceras, cuerpo: crudo.slice(corte + 4) }
}

/** Las partes de un multipart, sin el preámbulo ni el cierre. */
function partes(mensaje: Parte): Parte[] {
  const separador = /boundary="([^"]+)"/.exec(mensaje.cabeceras.get('content-type') ?? '')?.[1]
  assert.ok(separador, 'el multipart no declara boundary')
  const trozos = `\r\n${mensaje.cuerpo}`.split(`\r\n--${separador}`)
  assert.equal(trozos[0], '', 'hay texto antes de la primera parte')
  assert.equal(trozos[trozos.length - 1], '--', 'el multipart no cierra con --separador--')
  return trozos.slice(1, -1).map((trozo) => separar(trozo.replace(/^\r\n/, '')))
}

/** RFC 2047: el espacio entre dos palabras codificadas no forma parte del texto. */
const decodificarCabecera = (valor: string): string =>
  valor
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'))

/** Buffer.from ignora en silencio lo que no es base64: por eso se revisa cada línea antes. */
function decodificarBase64(texto: string): Buffer {
  const lineas = texto.split('\r\n')
  for (const linea of lineas) assert.match(linea, /^[A-Za-z0-9+/=]{0,76}$/)
  return Buffer.from(lineas.join(''), 'base64')
}

function leerAdjunto(parte: Parte) {
  const tipo = parte.cabeceras.get('content-type') ?? ''
  const disposicion = parte.cabeceras.get('content-disposition') ?? ''
  assert.equal(parte.cabeceras.get('content-transfer-encoding'), 'base64')
  assert.match(disposicion, /^attachment;/)
  const porcentual = /filename\*=UTF-8''([^\s;]+)/.exec(disposicion)?.[1]
  assert.ok(porcentual, `falta filename* en ${disposicion}`)
  // Solo los caracteres que RFC 2231 deja sin codificar.
  assert.match(porcentual, /^[A-Za-z0-9!#$&+\-.^_`|~%]+$/)
  return {
    tipo,
    nombre: decodeURIComponent(porcentual),
    nombreAscii: /filename="([^"]*)"/.exec(disposicion)?.[1],
    contenido: decodificarBase64(parte.cuerpo),
  }
}

describe('enviarCorreo', () => {
  it('sin adjuntos: el asunto va en RFC 2047 y el cuerpo llega exactamente como se escribió', async () => {
    await conServidor({}, async (servidor) => {
      const asunto = 'Terminó el cuestionario de Clínica Odontológica Sonrisa Plena — sucursal Belgrano'
      const cuerpo = 'Hola, Mateo.\n\nÑandú Café terminó el cuestionario: ¿lo revisás?\n.\nLa línea de arriba es un punto solo.'
      await enviarCorreo({ para: DESTINO, asunto, cuerpo })

      assert.equal(servidor.mensajes.length, 1)
      const crudo = servidor.mensajes[0]
      const mensaje = separar(crudo)

      const subject = mensaje.cabeceras.get('subject') ?? ''
      const palabras = subject.split(' ')
      assert.ok(palabras.length > 1, 'un asunto largo tiene que ir en varias palabras codificadas')
      for (const palabra of palabras) {
        assert.match(palabra, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
        assert.ok(palabra.length <= 75, `palabra codificada de ${palabra.length} caracteres`)
      }
      assert.equal(decodificarCabecera(subject), asunto)

      assert.equal(mensaje.cabeceras.get('from'), REMITENTE)
      assert.equal(mensaje.cabeceras.get('to'), DESTINO)
      assert.equal(mensaje.cabeceras.get('mime-version'), '1.0')
      assert.equal(mensaje.cabeceras.get('content-type'), 'text/plain; charset=UTF-8')
      assert.equal(mensaje.cabeceras.get('content-transfer-encoding'), 'base64')
      assert.match(mensaje.cabeceras.get('message-id') ?? '', /^<[0-9a-f]{32}@cuestionario\.test>$/)
      const date = mensaje.cabeceras.get('date') ?? ''
      assert.match(
        date,
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
      )
      assert.ok(Math.abs(Date.parse(date) - Date.now()) < 60_000)

      assert.equal(decodificarBase64(mensaje.cuerpo).toString('utf8'), cuerpo)
      assert.ok(crudo.split('\r\n').every((linea) => linea.length <= 998))
    })
  })

  it('con SMTP_USUARIO y SMTP_CLAVE se autentica con AUTH LOGIN, en base64', async () => {
    const usuario = 'avisos@cuestionario.test'
    const clave = 'abcd efgh ijkl ñandú'
    await conServidor({}, async (servidor) => {
      Object.assign(process.env, { SMTP_USUARIO: usuario, SMTP_CLAVE: clave })
      await enviarCorreo({ para: DESTINO, asunto: 'Tu link', cuerpo: 'Hola' })
      assert.deepEqual(servidor.comandos, [
        'EHLO cuestionario',
        'AUTH LOGIN',
        Buffer.from(usuario, 'utf8').toString('base64'),
        Buffer.from(clave, 'utf8').toString('base64'),
        `MAIL FROM:<${REMITENTE}>`,
        `RCPT TO:<${DESTINO}>`,
        'DATA',
        'QUIT',
      ])
      // Un asunto corto en ASCII va tal cual.
      assert.equal(separar(servidor.mensajes[0]).cabeceras.get('subject'), 'Tu link')
    })
  })

  it('sin usuario ni clave no manda AUTH', async () => {
    await conServidor({}, async (servidor) => {
      await enviarCorreo({ para: DESTINO, asunto: 'Tu link', cuerpo: 'Hola' })
      assert.deepEqual(servidor.comandos, ['EHLO cuestionario', `MAIL FROM:<${REMITENTE}>`, `RCPT TO:<${DESTINO}>`, 'DATA', 'QUIT'])
    })
  })

  it('con adjuntos arma un multipart/mixed y cada archivo llega con su contenido y su nombre', async () => {
    const brief = '# Brief comercial\n\nVende por WhatsApp y cobra una seña del 30 %. ¿Cuándo? Siempre antes del turno.\n'
    const cierre = Buffer.from('# Cierre — Norte\n\nPendiente: confirmar el precio del service.\n', 'utf8')
    await conServidor({}, async (servidor) => {
      await enviarCorreo({
        para: DESTINO,
        asunto: 'Cuestionario terminado: Norte',
        cuerpo: 'Van los archivos del cuestionario.',
        adjuntos: [
          { nombre: 'brief-comercial.md', tipo: 'text/markdown', contenido: brief },
          { nombre: 'cierre — Norte.md', tipo: 'text/markdown', contenido: cierre },
        ],
      })

      const mensaje = separar(servidor.mensajes[0])
      assert.match(mensaje.cabeceras.get('content-type') ?? '', /^multipart\/mixed; boundary="[^"]+"$/)
      const [texto, primero, segundo, ...sobran] = partes(mensaje)
      assert.equal(sobran.length, 0)

      assert.equal(texto.cabeceras.get('content-type'), 'text/plain; charset=UTF-8')
      assert.equal(texto.cabeceras.has('content-disposition'), false)
      assert.equal(decodificarBase64(texto.cuerpo).toString('utf8'), 'Van los archivos del cuestionario.')

      const briefLeido = leerAdjunto(primero)
      assert.equal(briefLeido.tipo, 'text/markdown; charset=UTF-8; name="brief-comercial.md"')
      assert.equal(briefLeido.nombre, 'brief-comercial.md')
      assert.equal(briefLeido.nombreAscii, 'brief-comercial.md')
      assert.equal(briefLeido.contenido.toString('utf8'), brief)

      const cierreLeido = leerAdjunto(segundo)
      // Un Buffer va con el tipo tal cual: no se sabe en qué está escrito.
      assert.equal(cierreLeido.tipo, 'text/markdown; name="cierre - Norte.md"')
      assert.equal(cierreLeido.nombre, 'cierre — Norte.md')
      assert.equal(cierreLeido.nombreAscii, 'cierre - Norte.md')
      assert.deepEqual(cierreLeido.contenido, cierre)
    })
  })

  it('si el servidor rechaza el destinatario, el error trae lo que respondió', async () => {
    await conServidor({ rcpt: '550 5.1.1 No existe ese buzón' }, async (servidor) => {
      await assert.rejects(enviarCorreo({ para: 'nadie@ejemplo.test', asunto: 'Tu link', cuerpo: 'Hola' }), (err: unknown) => {
        assert.ok(err instanceof ErrorCorreo)
        assert.match(err.message, /550 5\.1\.1 No existe ese buzón/)
        assert.match(err.message, /nadie@ejemplo\.test/)
        assert.equal(err.configuracion, false)
        return true
      })
      assert.equal(servidor.comandos.includes('DATA'), false)
      assert.equal(servidor.mensajes.length, 0)
    })
  })

  it('si el servidor corta la conexión a mitad de camino, falla con ErrorCorreo en vez de quedar colgado', async () => {
    await conServidor({ cortarEn: 'MAIL' }, async () => {
      await assert.rejects(enviarCorreo({ para: DESTINO, asunto: 'Tu link', cuerpo: 'Hola' }), (err: unknown) => {
        assert.ok(err instanceof ErrorCorreo)
        assert.match(err.message, /cortó la conexión|Se cortó la comunicación/)
        return true
      })
    })
  })

  it('rechaza un destinatario con saltos de línea, nombre o acentos sin llegar a conectar', async () => {
    await conServidor({}, async (servidor) => {
      for (const para of ['mateo@ejemplo.test>\r\nRCPT TO:<otro@ejemplo.test', 'Mateo <mateo@ejemplo.test>', 'josé@ejemplo.test']) {
        await assert.rejects(enviarCorreo({ para, asunto: 'Tu link', cuerpo: 'Hola' }), ErrorCorreo)
      }
      assert.equal(servidor.conexiones, 0)
    })
  })

  it('un mensaje de más de 20 MB falla sin llegar a conectar', async () => {
    await conServidor({}, async (servidor) => {
      const adjuntos = [{ nombre: 'grabacion.bin', tipo: 'application/octet-stream', contenido: Buffer.alloc(16 * 1024 * 1024) }]
      await assert.rejects(enviarCorreo({ para: DESTINO, asunto: 'Pesado', cuerpo: 'Va un archivo grande.', adjuntos }), (err: unknown) => {
        assert.ok(err instanceof ErrorCorreo)
        assert.match(err.message, /20 MB/)
        assert.match(err.message, /grabacion\.bin/)
        return true
      })
      assert.equal(servidor.conexiones, 0)
    })
  })
})

describe('configuración del correo', () => {
  const completa = {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_REMITENTE: REMITENTE,
    SMTP_USUARIO: REMITENTE,
    SMTP_CLAVE: 'abcd efgh ijkl mnop',
  }

  it('sin SMTP_HOST avisa que falta el servidor', () => {
    Object.assign(process.env, completa)
    delete process.env.SMTP_HOST
    assert.match(faltaParaCorreo() ?? '', /^Falta SMTP_HOST/)
    assert.equal(configuracionCorreo(), null)
  })

  it('sin SMTP_REMITENTE avisa que falta desde dónde mandar', () => {
    Object.assign(process.env, completa)
    delete process.env.SMTP_REMITENTE
    assert.match(faltaParaCorreo() ?? '', /^Falta SMTP_REMITENTE/)
    assert.equal(configuracionCorreo(), null)
  })

  it('usuario sin clave, o clave sin usuario, avisa cuál falta', () => {
    Object.assign(process.env, completa)
    delete process.env.SMTP_CLAVE
    assert.match(faltaParaCorreo() ?? '', /falta SMTP_CLAVE/)
    assert.equal(configuracionCorreo(), null)

    Object.assign(process.env, completa)
    delete process.env.SMTP_USUARIO
    assert.match(faltaParaCorreo() ?? '', /falta SMTP_USUARIO/)
    assert.equal(configuracionCorreo(), null)
  })

  it('con todo completo no falta nada: 587 por defecto con STARTTLS, y 465 con TLS directo', () => {
    Object.assign(process.env, completa)
    assert.equal(faltaParaCorreo(), null)
    assert.deepEqual(configuracionCorreo(), {
      host: 'smtp.gmail.com',
      puerto: 587,
      usuario: REMITENTE,
      clave: 'abcd efgh ijkl mnop',
      remitente: REMITENTE,
      tls: 'starttls',
    })

    process.env.SMTP_PUERTO = '465'
    assert.equal(configuracionCorreo()?.tls, 'directo')
    process.env.SMTP_TLS = 'starttls'
    assert.equal(configuracionCorreo()?.tls, 'starttls')
  })

  it('un SMTP_TLS o un SMTP_PUERTO que no existen se avisan sin repetir el valor', () => {
    Object.assign(process.env, completa, { SMTP_TLS: 'si' })
    assert.match(faltaParaCorreo() ?? '', /SMTP_TLS acepta directo, starttls o ninguno/)

    Object.assign(process.env, completa, { SMTP_TLS: '', SMTP_PUERTO: 'quinientos' })
    const falta = faltaParaCorreo() ?? ''
    assert.match(falta, /SMTP_PUERTO/)
    assert.equal(falta.includes('quinientos'), false)
  })

  it('SMTP_TLS=ninguno con un servidor de afuera es un error de configuración que explica por qué', async () => {
    Object.assign(process.env, completa, { SMTP_TLS: 'ninguno' })
    assert.match(faltaParaCorreo() ?? '', /sin cifrar/)
    await assert.rejects(enviarCorreo({ para: DESTINO, asunto: 'Tu link', cuerpo: 'Hola' }), (err: unknown) => {
      assert.ok(err instanceof ErrorCorreo)
      assert.equal(err.configuracion, true)
      assert.match(err.message, /sin cifrar/)
      assert.match(err.message, /localhost/)
      return true
    })
  })
})
