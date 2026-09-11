import { randomBytes } from 'node:crypto'
import { createConnection, isIP, type Socket } from 'node:net'
import { connect as conectarTls, type TLSSocket } from 'node:tls'

/**
 * Cliente SMTP mínimo, sin dependencias.
 *
 * nodemailer arrastra un árbol grande para dos casos —mandarle al cliente su link y mandar el
 * aviso de cuestionario terminado con sus archivos— que entran en un archivo de protocolo.
 * Node ya trae sockets, TLS y números aleatorios, que es todo lo que hace falta.
 *
 * QUÉ NO HACE, para que nadie se sorprenda: no implementa XOAUTH2, así que Gmail necesita una
 * contraseña de aplicación o un relay; no mantiene un pool de conexiones; no manda HTML; y no
 * negocia SMTPUTF8, así que una dirección con acentos se rechaza antes de conectar. Si algún
 * día hace falta algo de eso, se instala nodemailer: todo vive detrás de enviarCorreo() y el
 * cambio toca un solo archivo.
 */

export class ErrorCorreo extends Error {
  constructor(
    mensaje: string,
    readonly configuracion = false,
  ) {
    super(mensaje)
    this.name = 'ErrorCorreo'
  }
}

const NOMBRE_EHLO = 'cuestionario'

const TIEMPO_MAXIMO_MS = 30_000

// Gmail corta a los 25 MB contando la codificación, y cada servidor intermedio suma cabeceras:
// con 20 queda margen para que el mensaje no rebote a mitad de camino.
const TOPE_BYTES = 20 * 1024 * 1024

// RFC 5322 pide líneas de cabecera de hasta 78 caracteres.
const LARGO_LINEA_CABECERA = 78

// Sin cifrar, la clave y los adjuntos viajan legibles: solo se acepta si no salen de la máquina.
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1'])

const MODOS_TLS = ['directo', 'starttls', 'ninguno'] as const

export type ModoTls = (typeof MODOS_TLS)[number]

const esModoTls = (valor: string): valor is ModoTls => (MODOS_TLS as readonly string[]).includes(valor)

export interface ConfiguracionCorreo {
  host: string
  puerto: number
  usuario: string | null
  clave: string | null
  remitente: string
  /**
   * directo: TLS desde el saludo (465). starttls: se cifra después del primer EHLO (587).
   * ninguno: sin cifrar, solo contra un servidor local; existe para las pruebas.
   */
  tls: ModoTls
}

/**
 * Una dirección sola y en ASCII. Va tal cual en MAIL FROM, RCPT TO y las cabeceras: un salto de
 * línea o un «>» en la dirección que escribió el cliente alcanzaría para meter otro destinatario.
 */
const esDireccion = (valor: string): boolean =>
  /^[\x21-\x7e]+$/.test(valor) && /^[^<>()",;:@\\]+@[^<>()",;:@\\]+$/.test(valor)

// Un espacio pegado de más en SMTP_HOST termina en un error de DNS que no dice nada.
const variable = (nombre: string): string | null => process.env[nombre]?.trim() || null

/**
 * Los mensajes no repiten ningún valor de las variables: /api/salud es pública y tiene que
 * poder mostrar lo que devuelve faltaParaCorreo() tal cual.
 */
function leerConfiguracion(): ConfiguracionCorreo | string {
  const host = variable('SMTP_HOST')
  const remitente = variable('SMTP_REMITENTE')
  const usuario = variable('SMTP_USUARIO')
  // La clave no se recorta: un espacio puede ser parte de ella.
  const clave = process.env.SMTP_CLAVE || null
  const puertoEscrito = variable('SMTP_PUERTO')
  const tls = variable('SMTP_TLS')

  if (!host) return 'Falta SMTP_HOST: no hay servidor de correo configurado.'
  if (!remitente) return 'Falta SMTP_REMITENTE: no hay dirección desde la cual enviar.'
  if (!esDireccion(remitente)) {
    return 'SMTP_REMITENTE tiene que ser una dirección sola y sin acentos, como avisos@tudominio.com: sin nombre adelante ni <>.'
  }
  // Con uno solo de los dos no se manda AUTH y el servidor rechaza el envío más adelante, con
  // un error que no nombra a ninguna de las dos variables.
  if (usuario && !clave) {
    return 'Hay SMTP_USUARIO pero falta SMTP_CLAVE: sin la clave el servidor rechaza la autenticación. Con Gmail va una contraseña de aplicación, no la de la cuenta.'
  }
  if (clave && !usuario) {
    return 'Hay SMTP_CLAVE pero falta SMTP_USUARIO: completá la cuenta con la que se entra al servidor, o sacá SMTP_CLAVE si el servidor no pide autenticación.'
  }

  const puerto = puertoEscrito === null ? 587 : Number(puertoEscrito)
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    return 'SMTP_PUERTO tiene que ser un número de puerto, como 587 o 465. Si la dejás vacía se usa 587.'
  }

  let modo: ModoTls = puerto === 465 ? 'directo' : 'starttls'
  if (tls) {
    if (!esModoTls(tls)) {
      return 'SMTP_TLS acepta directo, starttls o ninguno. Si la dejás vacía se elige sola: directo con el puerto 465 y starttls con cualquier otro.'
    }
    modo = tls
  }
  if (modo === 'ninguno' && !HOSTS_LOCALES.has(host.toLowerCase())) {
    return 'SMTP_TLS=ninguno manda la clave y los adjuntos sin cifrar, así que solo vale con un servidor en esta misma máquina (SMTP_HOST en localhost, 127.0.0.1 o ::1). Para un servidor de afuera sacá SMTP_TLS: con el puerto 465 se usa TLS directo y con cualquier otro, STARTTLS.'
  }

  return { host, puerto, usuario, clave, remitente, tls: modo }
}

/** La configuración leída de las variables, o null si falta algo o algo está mal: el detalle lo da faltaParaCorreo(). */
export function configuracionCorreo(): ConfiguracionCorreo | null {
  const leida = leerConfiguracion()
  return typeof leida === 'string' ? null : leida
}

/** Qué falta o qué está mal para poder mandar correo, dicho para quien carga las variables. null si está todo. */
export function faltaParaCorreo(): string | null {
  const leida = leerConfiguracion()
  return typeof leida === 'string' ? leida : null
}

type Conexion = Socket | TLSSocket

interface SiFalla {
  /** Qué revisar, dicho para quien carga las variables. */
  ayuda: string
  /** Si lo que falló se arregla en las variables y no reintentando. */
  configuracion?: boolean
}

/** Lee una respuesta SMTP completa: las de varias líneas usan «250-» hasta la última, que usa «250 ». */
function leerRespuesta(socket: Conexion, esperado: number[], siFalla?: SiFalla): Promise<string> {
  return new Promise((resolver, rechazar) => {
    const cortada = () =>
      new ErrorCorreo(
        'El servidor de correo cortó la conexión sin responder. Si pasa siempre, revisá que SMTP_TLS corresponda a SMTP_PUERTO: el 465 va con directo y el 587 con starttls.',
      )
    if (socket.destroyed) {
      rechazar(cortada())
      return
    }

    let acumulado = ''
    const alDato = (trozo: Buffer) => {
      acumulado += trozo.toString('utf8')
      // Un trozo puede partir una línea al medio: sin el salto final la respuesta no está completa.
      if (!acumulado.endsWith('\n')) return
      const lineas = acumulado.split(/\r?\n/).filter(Boolean)
      const ultima = lineas[lineas.length - 1]
      if (!ultima || !/^\d{3}(?: |$)/.test(ultima)) return
      limpiar()
      const codigo = Number(ultima.slice(0, 3))
      if (esperado.includes(codigo)) {
        resolver(acumulado)
        return
      }
      // Gmail reparte la explicación en varias líneas y deja solo un enlace en la última.
      const texto = lineas
        .map((linea) => linea.slice(4).trim())
        .filter(Boolean)
        .join(' ')
      const respuesta = `El servidor de correo respondió «${texto ? `${codigo} ${texto}` : codigo}».`
      rechazar(new ErrorCorreo(siFalla ? `${respuesta} ${siFalla.ayuda}` : respuesta, siFalla?.configuracion))
    }
    const alError = (err: Error) => {
      limpiar()
      rechazar(new ErrorCorreo(`Se cortó la comunicación con el servidor de correo: ${err.message}`))
    }
    const alCerrar = () => {
      limpiar()
      rechazar(cortada())
    }
    const limpiar = () => {
      socket.off('data', alDato)
      socket.off('error', alError)
      socket.off('close', alCerrar)
    }
    socket.on('data', alDato)
    socket.on('error', alError)
    socket.on('close', alCerrar)
  })
}

function escribir(socket: Conexion, linea: string): void {
  socket.write(linea + '\r\n')
}

async function decir(socket: Conexion, linea: string, esperado: number[], siFalla?: SiFalla): Promise<string> {
  const respuesta = leerRespuesta(socket, esperado, siFalla)
  escribir(socket, linea)
  return respuesta
}

export interface Adjunto {
  /** Nombre con extensión, tal como lo va a ver quien lo recibe. Puede tener acentos y rayas. */
  nombre: string
  /** Tipo MIME, como text/markdown o application/pdf. */
  tipo: string
  /**
   * Un string se manda en UTF-8 y, si el tipo es text/* sin charset, se le agrega charset=UTF-8:
   * sin eso hay clientes que muestran los acentos rotos en la vista previa. Un Buffer va tal
   * cual, con el tipo que se le pase, porque no se sabe en qué está escrito.
   */
  contenido: Buffer | string
}

export interface Mensaje {
  /** Una sola dirección, sin nombre adelante. */
  para: string
  asunto: string
  /** Texto plano. No se manda HTML: un aviso con un link o con archivos adjuntos no lo necesita. */
  cuerpo: string
  adjuntos?: Adjunto[]
}

/**
 * El asunto, en RFC 2047 si hace falta.
 *
 * Sin esto un asunto con «Clínica» llega ilegible en la mitad de los clientes. Cada palabra
 * codificada admite hasta 75 caracteres, así que uno largo va en varias, y se parte entre
 * caracteres: una letra de dos bytes cortada al medio sale como un signo raro en todos lados.
 */
function asunto(valor: string): string {
  // El nombre del negocio lo escribe el cliente: un salto de línea en el asunto no tiene cómo mostrarse.
  const limpio = valor.replace(/[\x00-\x1f\x7f]+/g, ' ')
  if (/^[\x20-\x7e]*$/.test(limpio) && 'Subject: '.length + limpio.length <= LARGO_LINEA_CABECERA) return limpio

  const palabras: string[] = []
  let actual = ''
  for (const caracter of limpio) {
    // 45 bytes son 60 caracteres en base64: con «=?UTF-8?B?» y «?=» quedan 72.
    if (Buffer.byteLength(actual + caracter) > 45) {
      palabras.push(actual)
      actual = ''
    }
    actual += caracter
  }
  palabras.push(actual)
  return palabras.map((palabra) => `=?UTF-8?B?${Buffer.from(palabra, 'utf8').toString('base64')}?=`).join('\r\n ')
}

/** RFC 5322 pide la zona en números: toUTCString termina en «GMT», que la norma da por obsoleto. */
const fecha = (momento: Date): string => momento.toUTCString().replace(/GMT$/, '+0000')

/**
 * Todo el contenido va en base64 y en líneas de 76: evita por completo el problema de las
 * líneas largas y el del punto solo en una línea, que SMTP lee como fin del mensaje.
 */
function base64EnLineas(datos: Buffer): string {
  return (datos.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

/** Para los clientes que no leen filename*: sin acentos ni rayas, y sin comillas que corten el parámetro. */
const nombreAscii = (nombre: string): string =>
  nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]|["\\]/g, '_')

/** RFC 2231 en porcentual. encodeURIComponent deja pasar ' ( ) *, que en ese formato son especiales. */
const nombrePorcentual = (nombre: string): string =>
  encodeURIComponent(nombre).replace(/['()*]/g, (caracter) => `%${caracter.charCodeAt(0).toString(16).toUpperCase()}`)

// tipo/subtipo y, si vienen, parámetros en ASCII imprimible: nada que pueda cortar la cabecera.
const TIPO_MIME = /^[\w.+-]+\/[\w.+-]+(?: *;[\x20-\x7e]*)?$/

function parteAdjunto(adjunto: Adjunto): string[] {
  if (!adjunto.nombre.trim()) {
    throw new ErrorCorreo(
      'Hay un adjunto sin nombre: cada uno necesita nombre con extensión, como brief-comercial.md, para que se pueda abrir.',
    )
  }
  if (!TIPO_MIME.test(adjunto.tipo)) {
    throw new ErrorCorreo(
      `El adjunto ${JSON.stringify(adjunto.nombre)} no tiene un tipo MIME válido: usá algo como text/markdown o application/pdf.`,
    )
  }

  const esTexto = typeof adjunto.contenido === 'string'
  const tipo =
    esTexto && /^text\//i.test(adjunto.tipo) && !/charset=/i.test(adjunto.tipo) ? `${adjunto.tipo}; charset=UTF-8` : adjunto.tipo
  const contenido = typeof adjunto.contenido === 'string' ? Buffer.from(adjunto.contenido, 'utf8') : adjunto.contenido
  const ascii = nombreAscii(adjunto.nombre)

  return [
    `Content-Type: ${tipo}; name="${ascii}"`,
    `Content-Disposition: attachment; filename="${ascii}";`,
    // Los clientes actuales toman este y muestran el nombre con sus acentos y rayas.
    ` filename*=UTF-8''${nombrePorcentual(adjunto.nombre)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64EnLineas(contenido),
  ]
}

/** El mensaje entero, listo para mandar después del DATA y sin el punto final. */
function armarMensaje(cfg: ConfiguracionCorreo, mensaje: Mensaje): string {
  if (!esDireccion(mensaje.para)) {
    throw new ErrorCorreo(
      `La dirección de destino ${JSON.stringify(mensaje.para)} no es válida: tiene que ser una sola, como nombre@dominio.com, sin espacios, acentos ni nombre adelante.`,
    )
  }

  const dominio = cfg.remitente.slice(cfg.remitente.lastIndexOf('@') + 1)
  const cabeceras = [
    `From: ${cfg.remitente}`,
    `To: ${mensaje.para}`,
    `Subject: ${asunto(mensaje.asunto)}`,
    `Date: ${fecha(new Date())}`,
    // Gmail puede rechazar un mensaje que llega sin Message-ID: no se deja en manos del servidor.
    `Message-ID: <${randomBytes(16).toString('hex')}@${dominio}>`,
    'MIME-Version: 1.0',
  ]
  const cuerpo = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64EnLineas(Buffer.from(mensaje.cuerpo, 'utf8')),
  ]

  const adjuntos = mensaje.adjuntos ?? []
  if (adjuntos.length === 0) return [...cabeceras, ...cuerpo].join('\r\n')

  // Aleatorio para que no pueda coincidir con nada de lo que escribió el cliente.
  const separador = `cuestionario-${randomBytes(16).toString('hex')}`
  return [
    ...cabeceras,
    `Content-Type: multipart/mixed; boundary="${separador}"`,
    '',
    `--${separador}`,
    ...cuerpo,
    ...adjuntos.flatMap((adjunto) => [`--${separador}`, ...parteAdjunto(adjunto)]),
    `--${separador}--`,
  ].join('\r\n')
}

const megas = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`

/** Node avisa si el nombre para TLS es una IP (RFC 6066 no lo permite): con una IP no se manda. */
const nombreTls = (host: string): string | undefined => (isIP(host) ? undefined : host)

/**
 * Manda un correo.
 *
 * Único punto de salida: cambiar de proveedor o pasar a nodemailer toca sólo esta función.
 * Tarda como mucho 30 segundos; si vuelve sin error, el servidor aceptó el mensaje.
 */
export async function enviarCorreo(mensaje: Mensaje): Promise<void> {
  const cfg = configuracionCorreo()
  if (!cfg) throw new ErrorCorreo(faltaParaCorreo() ?? 'Correo sin configurar.', true)

  // Se arma entero antes de conectar: un destinatario inválido o un mensaje que no entra no
  // tienen por qué abrir una conexión que después hay que cortar.
  const datos = armarMensaje(cfg, mensaje)
  const bytes = Buffer.byteLength(datos)
  if (bytes > TOPE_BYTES) {
    const pesos = (mensaje.adjuntos ?? []).map((adjunto) => `${adjunto.nombre}, ${megas(Buffer.byteLength(adjunto.contenido))}`)
    const arreglo = pesos.length ? `Sacá o achicá adjuntos (${pesos.join('; ')})` : 'Achicá el cuerpo'
    throw new ErrorCorreo(
      `El mensaje pesa ${megas(bytes)} ya codificado y el tope es de ${TOPE_BYTES / 1024 / 1024} MB: más grande, Gmail y otros servidores lo rebotan. ${arreglo}.`,
    )
  }

  const socketInicial: Conexion =
    cfg.tls === 'directo'
      ? conectarTls({ host: cfg.host, port: cfg.puerto, servername: nombreTls(cfg.host) })
      : createConnection({ host: cfg.host, port: cfg.puerto })
  let socket = socketInicial
  // Un 'error' sin nadie escuchando tira abajo el proceso entero de Next. Los que importan los
  // toma leerRespuesta mientras espera; este cubre el instante entre un comando y el siguiente.
  socketInicial.on('error', () => undefined)

  // El tope no depende de ningún evento del socket: un servidor que acepta la conexión y no
  // contesta, o que se cierra sin avisar, dejaría la promesa colgada para siempre.
  let temporizador: ReturnType<typeof setTimeout> | undefined
  const vencido = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(
      () =>
        rechazar(
          new ErrorCorreo(
            `El servidor de correo ${cfg.host}:${cfg.puerto} no terminó de responder en ${TIEMPO_MAXIMO_MS / 1000} segundos. Si pasa siempre, lo más común es que SMTP_TLS no corresponda al puerto: el 465 va con directo y el 587 con starttls.`,
          ),
        ),
      TIEMPO_MAXIMO_MS,
    )
  })

  const conversar = async () => {
    await new Promise<void>((resolver, rechazar) => {
      socketInicial.once(cfg.tls === 'directo' ? 'secureConnect' : 'connect', () => resolver())
      socketInicial.once('error', (err) => {
        const pista =
          cfg.tls === 'directo' ? ' Con TLS directo el puerto tiene que cifrar desde el saludo, como el 465; si es el 587, poné SMTP_TLS=starttls.' : ''
        rechazar(
          new ErrorCorreo(
            `No se pudo conectar con ${cfg.host}:${cfg.puerto}. Revisá SMTP_HOST y SMTP_PUERTO, y que el servicio pueda salir a ese puerto.${pista} (${err.message})`,
          ),
        )
      })
    })

    await leerRespuesta(socket, [220])
    await decir(socket, `EHLO ${NOMBRE_EHLO}`, [250])

    if (cfg.tls === 'starttls') {
      await decir(socket, 'STARTTLS', [220], {
        ayuda: `El servidor no ofrece STARTTLS en el puerto ${cfg.puerto}. Si es el 465, sacá SMTP_TLS o poné SMTP_TLS=directo.`,
        configuracion: true,
      })
      const cifrado = conectarTls({ socket: socketInicial, host: cfg.host, servername: nombreTls(cfg.host) })
      cifrado.on('error', () => undefined)
      socket = cifrado
      await new Promise<void>((resolver, rechazar) => {
        cifrado.once('secureConnect', () => resolver())
        cifrado.once('error', (err) =>
          rechazar(
            new ErrorCorreo(
              `Falló el cifrado con ${cfg.host}: ${err.message}. Revisá que SMTP_HOST sea el nombre que figura en el certificado del servidor, no una IP ni un alias.`,
            ),
          ),
        )
      })
      // Lo que el servidor anunció antes de cifrar deja de valer: hay que volver a saludar.
      await decir(socket, `EHLO ${NOMBRE_EHLO}`, [250])
    }

    if (cfg.usuario && cfg.clave) {
      const credenciales: SiFalla = {
        ayuda: 'Revisá SMTP_USUARIO y SMTP_CLAVE. Con Gmail, SMTP_CLAVE tiene que ser una contraseña de aplicación: la de la cuenta no sirve.',
        configuracion: true,
      }
      // AUTH LOGIN: el más compatible. Usuario y clave van en base64, uno por vez.
      await decir(socket, 'AUTH LOGIN', [334], {
        ayuda: 'El servidor no acepta AUTH LOGIN, que es el único mecanismo que sabe usar este cliente: hace falta otro servidor o un relay que lo acepte.',
        configuracion: true,
      })
      await decir(socket, Buffer.from(cfg.usuario, 'utf8').toString('base64'), [334], credenciales)
      await decir(socket, Buffer.from(cfg.clave, 'utf8').toString('base64'), [235], credenciales)
    }

    await decir(socket, `MAIL FROM:<${cfg.remitente}>`, [250], {
      ayuda: 'Revisá SMTP_REMITENTE: muchos servidores, Gmail entre ellos, solo dejan mandar desde la cuenta de SMTP_USUARIO o desde un alias verificado.',
      configuracion: true,
    })
    await decir(socket, `RCPT TO:<${mensaje.para}>`, [250, 251], {
      ayuda: `Revisá que ${mensaje.para} exista. Si la respuesta habla de relay, el servidor pide autenticarse: completá SMTP_USUARIO y SMTP_CLAVE.`,
    })
    await decir(socket, 'DATA', [354])

    const aceptado = leerRespuesta(socket, [250])
    socket.write(`${datos}\r\n.\r\n`)
    await aceptado
  }

  try {
    await Promise.race([conversar(), vencido])
    // El mensaje ya quedó aceptado: si el QUIT falla o tarda, no hay nada que avisar, y tirar
    // un error acá haría que quien llama lo reintente y llegue dos veces.
    await Promise.race([decir(socket, 'QUIT', [221]), vencido]).catch(() => undefined)
  } finally {
    clearTimeout(temporizador)
    socketInicial.destroy()
    socket.destroy()
  }
}
