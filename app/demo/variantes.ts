import type { EstadoPublico } from '@/lib/estado-publico'
import type { Etapa, Pantalla, Propuesta } from '@/lib/motor/tipos'
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
    nota: 'Escribí algo y recargá: el borrador vuelve. Ctrl + Enter envía.',
    tipo: 'pantalla',
    estado: estado(
      'triage',
      {
        tipo: 'pregunta',
        clave: 'triage.1',
        introduccion:
          'Antes de armarte el cuestionario necesito entender cómo funciona tu negocio. Seis preguntas, dos minutos.',
        texto:
          'Pensá en el último chat que salió bien, uno que terminó como vos querías. ¿En qué terminó exactamente? Por ejemplo: la persona pagó, quedó agendada, la mandaste a la web, te dejó los datos y la llamaste después, te hizo un pedido.',
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
    nota: '«Listo» se habilita con texto o con capturas subidas.',
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
          { id: 'c1', nombre: 'Captura de pantalla 2026-09-02 a las 18.41.12.png', tipo: 'imagen' },
          { id: 'c2', nombre: 'Captura de pantalla 2026-09-02 a las 18.41.40.png', tipo: 'imagen' },
        ],
      },
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
    nota: 'Probá subir (también arrastrando), un video o algo de más de 20 MB, y pegar un texto.',
    tipo: 'pantalla',
    estado: estado(
      'material',
      { tipo: 'material', items: ITEMS_MATERIAL, archivos: [], textos: [], aviso: null },
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
          { id: 'm1', nombre: 'Chat con Marcela - monstera.png', tipo: 'imagen' },
          { id: 'm2', nombre: 'Lista de precios septiembre.pdf', tipo: 'pdf' },
          { id: 'm3', nombre: 'Chat de WhatsApp con Jorge Ramírez del vivero de Pilar.zip', tipo: 'texto' },
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
