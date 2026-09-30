import type { EstadoPublico } from '@/lib/estado-publico'
import * as textos from '@/lib/motor/textos'
import type { ArchivoPublico, Etapa, Pantalla, Propuesta, TipoMaterial } from '@/lib/motor/tipos'
import type { Lote } from '../c/[token]/componentes/SubidaDeArchivos'
import type { ModoInicial } from '../c/[token]/componentes/VistaCuestionario'

/**
 * Datos de ejemplo de la galería de /demo. Todo inventado: el repositorio es público y acá no
 * va nada de clientes reales.
 */

export interface Variante {
  id: string
  titulo: string
  /** Qué mirar o probar en esta variante. */
  nota?: string
  tipo: 'pantalla' | 'cargando' | 'invalido' | 'sin_conexion'
  estado?: EstadoPublico
  /** El aviso de arriba, como el de otra pestaña. */
  aviso?: string
  /** Un error de formulario ya visible al abrir. */
  error?: string
  modoInicial?: ModoInicial
  /** Subidas de muestra, para ver el panel con algo subiendo y algo que falló sin subir nada. */
  subidas?: Lote[]
}

function estado(
  etapa: Etapa,
  pantalla: Pantalla,
  porcentaje: number,
  texto: string,
  extra: Partial<EstadoPublico> = {},
): EstadoPublico {
  return {
    version: 1,
    negocio: 'Panadería de Prueba',
    email: 'dueno@ejemplo.com',
    etapa,
    procesando: false,
    mensajeEspera: null,
    error: null,
    entradaPendiente: null,
    progreso: { porcentaje, texto },
    pantalla,
    ...extra,
  }
}

/** Un archivo ya subido. Por defecto está leído, suelto y sin notas. */
function archivo(
  id: string,
  nombre: string,
  tipo: TipoMaterial,
  grupo: string | null,
  extra: Partial<ArchivoPublico> = {},
): ArchivoPublico {
  return {
    id,
    nombre,
    tipo,
    estado: extra.problema ? 'con_problema' : 'listo',
    problema: null,
    grupo,
    esChat: false,
    duracion: null,
    bytes: 180_000,
    ...extra,
  }
}

const VENTA = '1 - Venta cerrada - Marcela'
const SIN_COMPRA = '2 - Preguntó y no compró'
const ZIP_JORGE = 'WhatsApp Chat - Jorge Ramírez'

const CONVERSACION_VENTA: ArchivoPublico[] = [
  archivo('v1', '_chat.txt', 'texto', VENTA, { esChat: true, bytes: 6_420 }),
  archivo('v2', '00000007-AUDIO-2026-09-02-10-12-44.opus', 'audio', VENTA, { duracion: 13 }),
  archivo('v3', '00000009-AUDIO-2026-09-02-10-15-03.opus', 'audio', VENTA, { duracion: 48 }),
  archivo('v4', '00000011-PHOTO-2026-09-02-10-16-20.jpg', 'imagen', VENTA),
  archivo('v5', '00000012-PHOTO-2026-09-02-10-16-31.jpg', 'imagen', VENTA),
  archivo('v6', '00000015-Presupuesto monstera y maceta.pdf', 'pdf', VENTA),
  archivo('v7', '00000018-VIDEO-2026-09-02-10-31-09.mp4', 'video', VENTA, { duracion: 62, bytes: 9_400_000 }),
  archivo('v8', '00000021-AUDIO-2026-09-02-10-40-57.opus', 'audio', VENTA, { duracion: 7 }),
]

const CONVERSACION_SIN_COMPRA: ArchivoPublico[] = [
  archivo('n1', '_chat.txt', 'texto', SIN_COMPRA, { esChat: true, bytes: 2_190 }),
  archivo('n2', 'PTT-20260905-WA0003.opus', 'audio', SIN_COMPRA, { duracion: 21 }),
  archivo('n3', 'IMG-20260905-WA0004.jpg', 'imagen', SIN_COMPRA),
]

const CONVERSACION_ZIP: ArchivoPublico[] = [
  archivo('z1', '_chat.txt', 'texto', ZIP_JORGE, { esChat: true, bytes: 11_034 }),
  archivo('z2', '00000031-PHOTO-2026-09-11-17-02-40.jpg', 'imagen', ZIP_JORGE),
  archivo('z3', '00000034-AUDIO-2026-09-11-17-05-12.opus', 'audio', ZIP_JORGE, { duracion: 95 }),
  archivo('z4', '00000040-PHOTO-2026-09-11-17-20-08.jpg', 'imagen', ZIP_JORGE),
]

const PEDIDO_CHAT =
  'Con esto no puedo armarte un cuestionario a medida. Necesito material real: pegame la última conversación de WhatsApp de tu negocio que terminó bien.'

const CONFIRMACION =
  'Por lo que me contaste, vendés plantas y macetas por WhatsApp, y un chat bueno termina cuando **la persona te manda el comprobante de la transferencia** y le confirmás el día de entrega.\n\nLa mayoría te escribe una sola vez. Antes de contestar tenés que fijarte **si hay stock** y **en qué zona vive**, porque de eso depende el costo del envío.\n\n¿Va bien así?'

const ITEMS_MATERIAL = [
  'Entre 3 y 5 chats de WhatsApp que terminaron en venta, completos',
  '1 o 2 chats donde la persona **no compró**',
  'Tu lista de precios actual, con el costo de envío por zona',
  'Los mensajes que mandás siempre igual: saludo, formas de pago, horarios',
]

const PROPUESTA_ENVIOS: Propuesta = {
  texto:
    'Envíos de martes a sábado, de 10 a 18 h.\nCABA: $4.500\nZona norte (hasta Tigre): $6.800\nCompras de más de $60.000: envío sin cargo en CABA 🌿',
  fuente: 'Lista de precios septiembre.pdf',
}

const ENTREVISTA_PRECIOS: Pantalla = {
  tipo: 'entrevista',
  seccion: { numero: 3, titulo: 'Precios y formas de pago' },
  pregunta: {
    id: '3.2',
    texto:
      '¿Cambia el precio según cómo paga la persona? Contame cada forma de pago y qué precio le pasás en cada caso.',
  },
  formato: 'dato',
  propuesta: null,
  repregunta: null,
}

export const VARIANTES: Variante[] = [
  {
    id: 'pregunta',
    titulo: 'Pregunta con introducción',
    nota: 'Escribí algo y recargá: el borrador vuelve. Tocá «Siguiente» sin escribir para ver el aviso.',
    tipo: 'pantalla',
    estado: estado(
      'triage',
      {
        tipo: 'pregunta',
        clave: 'triage.1',
        introduccion: textos.INTRODUCCION_TRIAGE,
        texto: textos.PREGUNTAS_TRIAGE[0].texto,
        esRepregunta: false,
      },
      4,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'repregunta',
    titulo: 'Repregunta',
    tipo: 'pantalla',
    estado: estado(
      'triage',
      {
        tipo: 'pregunta',
        clave: 'triage.2',
        introduccion: null,
        texto:
          '¿Y qué fue lo último que hiciste vos en ese chat? ¿Le mandaste un link, lo anotaste en algún lado, le pasaste un dato?',
        esRepregunta: true,
      },
      6,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'pregunta-errores',
    titulo: 'Aviso de otra pestaña y error del servidor',
    nota: 'Así se ven el 409 (arriba) y un 400 junto al formulario.',
    tipo: 'pantalla',
    aviso: 'Se actualizó desde otra pestaña.',
    error: 'La respuesta llegó vacía. Escribí algo antes de seguir.',
    estado: estado(
      'reconstruccion',
      {
        tipo: 'pregunta',
        clave: 'reconstruccion.1',
        introduccion: null,
        texto: '¿Qué te escribió la persona? Lo primero que te llegó.',
        esRepregunta: false,
      },
      12,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'pedido-chat',
    titulo: 'Pedido de chat',
    nota: '«Listo» se habilita con texto o con algo subido: el .zip de WhatsApp, la carpeta del chat o capturas.',
    tipo: 'pantalla',
    estado: estado(
      'pedido_chat',
      { tipo: 'pedido_chat', texto: PEDIDO_CHAT, sinChat: 'No guardo los chats', archivos: [] },
      10,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'pedido-chat-capturas',
    titulo: 'Pedido de chat con capturas subidas',
    tipo: 'pantalla',
    estado: estado(
      'pedido_chat',
      {
        tipo: 'pedido_chat',
        texto: PEDIDO_CHAT,
        sinChat: 'No guardo los chats',
        archivos: [
          archivo('c1', 'Captura de pantalla 2026-09-02 a las 18.41.12.png', 'imagen', null),
          archivo('c2', 'Captura de pantalla 2026-09-02 a las 18.41.40.png', 'imagen', null),
        ],
      },
      10,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'pedido-chat-zip',
    titulo: 'Pedido de chat con el .zip de WhatsApp subido',
    nota: 'El .zip queda abierto en sus archivos, como una conversación.',
    tipo: 'pantalla',
    estado: estado(
      'pedido_chat',
      { tipo: 'pedido_chat', texto: PEDIDO_CHAT, sinChat: 'No guardo los chats', archivos: CONVERSACION_ZIP },
      10,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'eleccion',
    titulo: 'Elección entre dos procesos',
    tipo: 'pantalla',
    estado: estado(
      'eleccion',
      {
        tipo: 'eleccion',
        texto:
          'Tenés dos procesos distintos conviviendo. La primera versión del agente sirve a uno solo, después le sumás el otro. ¿Cuál te resuelve más problema hoy?',
        opciones: [
          'Vender plantas y macetas con envío a domicilio',
          'Agendar visitas para diseñar jardines y balcones',
        ],
      },
      16,
      'Conociendo tu negocio',
    ),
  },
  {
    id: 'confirmacion',
    titulo: 'Confirmación',
    tipo: 'pantalla',
    estado: estado('confirmacion', { tipo: 'confirmacion', texto: CONFIRMACION }, 18, 'Conociendo tu negocio'),
  },
  {
    id: 'confirmacion-corrigiendo',
    titulo: 'Confirmación con «No, te corrijo» desplegado',
    tipo: 'pantalla',
    modoInicial: 'correccion',
    estado: estado('confirmacion', { tipo: 'confirmacion', texto: CONFIRMACION }, 18, 'Conociendo tu negocio'),
  },
  {
    id: 'material',
    titulo: 'Material, vacío',
    nota: 'Probá subir una carpeta, un .zip, un audio o un video, crear una conversación nueva, renombrarla y quitarla.',
    tipo: 'pantalla',
    estado: estado(
      'material',
      { tipo: 'material', items: ITEMS_MATERIAL, archivos: [], textos: [], aviso: null, avisoLectura: null },
      24,
      'Juntando material',
    ),
  },
  {
    id: 'material-aviso',
    titulo: 'Material con archivos, textos y aviso',
    tipo: 'pantalla',
    estado: estado(
      'material',
      {
        tipo: 'material',
        items: ITEMS_MATERIAL,
        archivos: [
          archivo('m1', 'Chat con Marcela - monstera.png', 'imagen', null),
          archivo('m2', 'Lista de precios septiembre.pdf', 'pdf', null, { problema: textos.PROBLEMA_LARGO }),
          // Así quedaba un .zip antes de que se abriera en sus archivos: un solo texto, suelto.
          archivo('m3', 'Chat de WhatsApp con Jorge Ramírez del vivero de Pilar.zip', 'texto', null),
        ],
        textos: [
          {
            id: 't1',
            extracto:
              '¡Hola! Gracias por escribirnos 🌿 Hacemos envíos de martes a sábado en CABA y zona norte…',
          },
        ],
        aviso:
          'Todavía no vi **ningún chat donde la persona no haya comprado**. Si tenés uno, sumalo: sirve para saber qué pasa cuando alguien se enfría.',
        avisoLectura: null,
      },
      27,
      'Juntando material',
    ),
  },
  {
    id: 'material-conversaciones',
    titulo: 'Material con conversaciones',
    nota: 'Tres conversaciones con chat, audios, fotos, PDF y video, y una lista de precios aparte. Probá «Ver archivos», «Agregar», «Cambiar nombre» y «Quitar».',
    tipo: 'pantalla',
    estado: estado(
      'material',
      {
        tipo: 'material',
        items: ITEMS_MATERIAL,
        archivos: [
          ...CONVERSACION_VENTA,
          ...CONVERSACION_SIN_COMPRA,
          ...CONVERSACION_ZIP,
          archivo('o1', 'Lista de precios septiembre.pdf', 'pdf', null),
        ],
        textos: [],
        aviso: null,
        avisoLectura: null,
      },
      27,
      'Juntando material',
    ),
  },
  {
    id: 'material-problemas',
    titulo: 'Material con archivos que no se pudieron leer',
    nota: 'Volvió a la lista después de «Listo, seguir». Las tarjetas con una nota se muestran abiertas, y la conversación subida dos veces lo avisa.',
    tipo: 'pantalla',
    estado: estado(
      'material',
      {
        tipo: 'material',
        items: ITEMS_MATERIAL,
        archivos: [
          archivo('p1', '_chat.txt', 'texto', VENTA, { esChat: true, bytes: 6_420 }),
          archivo('p2', '00000007-AUDIO-2026-09-02-10-12-44.opus', 'audio', VENTA, { duracion: 13 }),
          archivo('p3', '00000009-AUDIO-2026-09-02-10-15-03.opus', 'audio', VENTA, {
            problema: textos.PROBLEMA_AUDIO,
          }),
          archivo('p4', '00000011-PHOTO-2026-09-02-10-16-20.jpg', 'imagen', VENTA),
          archivo('p5', '_chat.txt', 'texto', `${VENTA} (2)`, { esChat: true, bytes: 6_420 }),
          archivo('p6', '00000007-AUDIO-2026-09-02-10-12-44.opus', 'audio', `${VENTA} (2)`, { duracion: 13 }),
          archivo('p7', 'Catálogo de macetas 2019.doc', 'otro', null, { problema: textos.PROBLEMA_FORMATO }),
        ],
        textos: [],
        aviso: null,
        avisoLectura: textos.AVISO_LECTURA,
      },
      27,
      'Juntando material',
    ),
  },
  {
    id: 'material-en-proceso',
    titulo: 'Material con audios que todavía se están escuchando',
    nota: 'A los 20 segundos consulta sola; cuando no queda nada en proceso, sigue sin que haya que tocar nada.',
    tipo: 'pantalla',
    estado: estado(
      'material',
      {
        tipo: 'material',
        items: ITEMS_MATERIAL,
        archivos: [
          ...CONVERSACION_SIN_COMPRA,
          archivo('e1', '_chat.txt', 'texto', ZIP_JORGE, { esChat: true, bytes: 11_034 }),
          archivo('e2', '00000034-AUDIO-2026-09-11-17-05-12.opus', 'audio', ZIP_JORGE, { estado: 'en_proceso' }),
          archivo('e3', '00000036-VIDEO-2026-09-11-17-09-30.mp4', 'video', ZIP_JORGE, {
            estado: 'en_proceso',
            bytes: 14_800_000,
          }),
          archivo('e4', '00000040-PHOTO-2026-09-11-17-20-08.jpg', 'imagen', ZIP_JORGE),
        ],
        textos: [],
        aviso: null,
        avisoLectura: textos.AVISO_EN_PROCESO,
      },
      27,
      'Juntando material',
    ),
  },
  {
    id: 'material-subiendo',
    titulo: 'Material con una subida en curso y otra con errores',
    nota: 'Las filas son de muestra: «Cancelar», «Reintentar» y «Cerrar» las sacan. Mientras haya algo subiendo no se puede seguir ni quitar.',
    tipo: 'pantalla',
    subidas: [
      {
        clave: 1,
        grupo: VENTA,
        zip: null,
        total: 16,
        hechos: 5,
        subiendo: true,
        bytesTotales: 35_000_000,
        bytesEnviados: 12_600_000,
        bytesDelActual: 2_100_000,
        errores: [],
        agregados: 5,
        repetidos: 0,
        omitidos: [],
      },
      {
        clave: 2,
        grupo: null,
        zip: 'WhatsApp Chat - Jorge Ramírez.zip',
        total: 1,
        hechos: 0,
        subiendo: false,
        bytesTotales: 14_800_000,
        bytesEnviados: 0,
        bytesDelActual: 0,
        errores: [],
        agregados: 0,
        repetidos: 0,
        omitidos: [],
      },
      {
        clave: 3,
        grupo: SIN_COMPRA,
        zip: null,
        total: 5,
        hechos: 3,
        subiendo: true,
        bytesTotales: 4_000_000,
        bytesEnviados: 4_000_000,
        bytesDelActual: 0,
        errores: [
          {
            clave: 31,
            nombre: 'VID-20260905-WA0009.mp4',
            error: 'La subida se cortó. Revisá la conexión y tocá «Reintentar»: sigue desde donde quedó.',
            reintentable: true,
          },
          {
            clave: 32,
            nombre: 'Recorrida por el vivero (completa).mov',
            error:
              '«Recorrida por el vivero (completa).mov» pesa más de 200 MB. Si es un video, mandá uno más corto o el que quedó en WhatsApp; si es un .zip, exportá cada conversación por separado.',
            reintentable: false,
          },
        ],
        agregados: 3,
        repetidos: 0,
        omitidos: [],
      },
    ],
    estado: estado(
      'material',
      {
        tipo: 'material',
        items: ITEMS_MATERIAL,
        archivos: [...CONVERSACION_VENTA.slice(0, 5), ...CONVERSACION_SIN_COMPRA],
        textos: [],
        aviso: null,
        avisoLectura: null,
      },
      27,
      'Juntando material',
    ),
  },
  {
    id: 'entrevista',
    titulo: 'Entrevista: un dato',
    tipo: 'pantalla',
    estado: estado('entrevista', ENTREVISTA_PRECIOS, 38, 'Cuestionario a medida'),
  },
  {
    id: 'entrevista-literal',
    titulo: 'Entrevista: texto literal con repregunta',
    tipo: 'pantalla',
    estado: estado(
      'entrevista',
      {
        tipo: 'entrevista',
        seccion: { numero: 5, titulo: 'Cómo le escribís al cliente' },
        pregunta: {
          id: '5.1',
          texto: '¿Qué le mandás a alguien que te escribe por primera vez preguntando por una planta?',
        },
        formato: 'texto_literal',
        propuesta: null,
        repregunta:
          'Eso que me pasaste es el mensaje para cuando **sí hay stock**. ¿Qué le mandás cuando la planta **no está disponible**?',
      },
      52,
      'Cuestionario a medida',
    ),
  },
  {
    id: 'entrevista-propuesta',
    titulo: 'Entrevista con propuesta del material',
    tipo: 'pantalla',
    estado: estado(
      'entrevista',
      {
        tipo: 'entrevista',
        seccion: { numero: 4, titulo: 'Envíos y zonas' },
        pregunta: { id: '4.1', texto: '¿Cuánto cuesta el envío y a qué zonas llegás?' },
        formato: 'dato',
        propuesta: PROPUESTA_ENVIOS,
        repregunta: null,
      },
      45,
      'Cuestionario a medida',
    ),
  },
  {
    id: 'entrevista-cambio',
    titulo: 'Propuesta con «Cambió» desplegado',
    tipo: 'pantalla',
    modoInicial: 'cambio',
    estado: estado(
      'entrevista',
      {
        tipo: 'entrevista',
        seccion: { numero: 4, titulo: 'Envíos y zonas' },
        pregunta: { id: '4.2', texto: '¿Cuánto cuesta el envío y a qué zonas llegás?' },
        formato: 'dato',
        propuesta: PROPUESTA_ENVIOS,
        repregunta: null,
      },
      45,
      'Cuestionario a medida',
    ),
  },
  {
    id: 'entrevista-no-aplica',
    titulo: 'Entrevista con «No aplica» desplegado',
    tipo: 'pantalla',
    modoInicial: 'no_aplica',
    estado: estado(
      'entrevista',
      {
        tipo: 'entrevista',
        seccion: { numero: 7, titulo: 'Después de la venta' },
        pregunta: {
          id: '7.3',
          texto: '¿Le escribís a la persona después de que recibió el pedido? ¿Qué le decís?',
        },
        formato: 'texto_literal',
        propuesta: null,
        repregunta: null,
      },
      71,
      'Cuestionario a medida',
    ),
  },
  {
    id: 'pregunta-final',
    titulo: 'Pregunta final',
    tipo: 'pantalla',
    estado: estado(
      'preguntas_finales',
      {
        tipo: 'pregunta_final',
        numero: 2,
        total: 4,
        texto:
          'En un momento dijiste que el envío a zona norte sale $6.800 y en otro que depende de la distancia. ¿Cuál de las dos usás hoy?',
      },
      94,
      'Casi terminamos',
    ),
  },
  {
    id: 'espera',
    titulo: 'Espera',
    nota: 'Con «reducir movimiento» activado en el sistema, los renglones quedan quietos.',
    tipo: 'pantalla',
    estado: estado('entrevista', ENTREVISTA_PRECIOS, 38, 'Cuestionario a medida', {
      procesando: true,
      mensajeEspera: 'Leyendo lo que contestaste para armar la próxima pregunta…',
    }),
  },
  {
    id: 'fallo',
    titulo: 'Error al procesar, con «Reintentar»',
    tipo: 'pantalla',
    estado: estado('entrevista', ENTREVISTA_PRECIOS, 38, 'Cuestionario a medida', {
      error:
        'No pudimos procesar tu respuesta porque el servicio que arma las preguntas tardó demasiado. Tocá **Reintentar** en un momento.',
      entradaPendiente: {
        tipo: 'respuesta',
        texto: 'Transferencia: precio de lista. Efectivo al retirar: 10 % menos.',
      },
    }),
  },
  {
    id: 'gracias',
    titulo: 'Gracias',
    tipo: 'pantalla',
    estado: estado(
      'terminado',
      {
        tipo: 'gracias',
        texto:
          '¡Listo, muchas gracias!\n\nCon lo que contaste ya tenemos todo para empezar. Si hace falta aclarar algo, te escribimos al mail que dejaste.',
      },
      100,
      'Terminado',
    ),
  },
  { id: 'cargando', titulo: 'Cargando', nota: 'Aparece con demora para no parpadear.', tipo: 'cargando' },
  { id: 'link-invalido', titulo: 'Link inválido (404)', tipo: 'invalido' },
  { id: 'sin-conexion', titulo: 'Sin conexión al abrir', tipo: 'sin_conexion' },
]
