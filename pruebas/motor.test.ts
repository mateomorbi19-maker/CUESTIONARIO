import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ErrorIa, type ClienteIa, type PedidoJson } from '../lib/claude'
import type {
  SalidaAlcance,
  SalidaBriefFinal,
  SalidaCierre,
  SalidaClasificacion,
  SalidaEvaluacion,
  SalidaEvaluacionEntrevista,
  SalidaExamenModelo,
} from '../lib/motor/instrucciones'
import { soloLiteral } from '../lib/motor/material'
import {
  avanzar,
  ErrorEntrada,
  ErrorMultimedia,
  estadoInicial,
  INTENTOS_EXAMEN,
  MAXIMO_PREGUNTAS_FINALES,
  mensajeEspera,
  pantallaActual,
  progreso,
  type Dependencias,
} from '../lib/motor/motor'
import * as textos from '../lib/motor/textos'
import type { ArchivoMaterial, Entrada, EstadoCuestionario, Transcripcion } from '../lib/motor/tipos'

/** IA falsa: devuelve, en orden, las respuestas preparadas para cada paso. */
function iaFalsa(respuestas: Record<string, unknown[]>): ClienteIa & { pedidos: PedidoJson[] } {
  const pedidos: PedidoJson[] = []
  return {
    modelo: 'falso',
    pedidos,
    async pedirJson<T>(pedido: PedidoJson): Promise<T> {
      pedidos.push(pedido)
      const cola = respuestas[pedido.paso]
      if (!cola?.length) throw new Error(`La IA falsa no tiene respuesta preparada para el paso ${pedido.paso}.`)
      return structuredClone(cola.shift()) as T
    },
  }
}

const pasos = (ia: { pedidos: PedidoJson[] }) => ia.pedidos.map((p) => p.paso)

const escucha = (texto: string, mas: Partial<Transcripcion> = {}): Transcripcion => ({
  texto,
  segundos: 13,
  sinVoz: false,
  dudosa: false,
  recortada: false,
  ...mas,
})

/** Sin ffmpeg ni Whisper: lo que escucharía y vería el servidor se inventa acá. */
function dependencias(ia: ClienteIa, archivos: Record<string, Buffer> = {}): Dependencias {
  return {
    ia,
    skill: async (nombre) => `TEXTO DE LA SKILL ${nombre}`,
    leerArchivo: async (archivo) => archivos[archivo.id] ?? Buffer.from('contenido'),
    plantillaClaude: async () => '# [Tu negocio]\n\n## Qué es este proyecto\n\n[PENDIENTE — lo completa /entrevista]',
    imagenParaClaude: async (archivo) => ({ datos: archivos[archivo.id] ?? Buffer.from('contenido'), mime: 'image/png' }),
    transcribirAudio: async (archivo) => escucha(`transcripción de ${archivo.nombre}`),
    fotogramasDeVideo: async () => ({ cuadros: [Buffer.from('cuadro 1'), Buffer.from('cuadro 2')], segundos: 47, tieneVideo: true, tieneAudio: true }),
  }
}

const seguir: SalidaEvaluacion = { decision: 'seguir', repregunta: '' }
const alcanza: SalidaAlcance = { alcanza: true, accion_terminal: 'turno reservado', datos_concretos: ['60 por semana', 'Doctoralia', 'agenda'] }
const noAlcanza: SalidaAlcance = { alcanza: false, accion_terminal: '', datos_concretos: [] }
const clasificacionSimple: SalidaClasificacion = {
  accion_terminal: 'turno reservado',
  arquetipo: 'B',
  hibrido: false,
  procesos: [],
  mensaje: 'Tu caso es agendamiento. ¿Vamos bien o me estoy equivocando en algo?',
}

function examenValido(): SalidaExamenModelo {
  const secciones = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((numero) => ({
    numero,
    preguntas: [1, 2, 3, 4].map((i) =>
      [5, 6, 9].includes(numero) ? `Pegá cómo respondés en el caso ${numero}.${i}.` : `¿Qué dato ${numero}.${i} anotás? Nombralo.`,
    ),
  }))
  secciones[7].preguntas[2] = '¿Qué parte de atender un chat vas a seguir haciendo vos aunque el agente esté andando? Nombrala.'
  secciones[7].preguntas[3] = '¿Hay algo que no querés que se mencione nunca por chat? Escribilo.'
  return { negocio: 'Clínica', nota: '', material: ['Chat 1', 'Chat 2', 'Chat 3'], secciones }
}

async function aplicar(estado: EstadoCuestionario, entradas: Entrada[], dep: Dependencias): Promise<EstadoCuestionario> {
  for (const entrada of entradas) estado = await avanzar(estado, entrada, dep)
  return estado
}

const respuesta = (texto: string): Entrada => ({ tipo: 'respuesta', texto })
const respuestasDelTriage = textos.PREGUNTAS_TRIAGE.map((_, i) => respuesta(`respuesta ${i + 1}`))

const GUION = `Te mando un video corto con las diferencias entre los modelos.
Trabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años.
El tiempo de fabricación es de 5 dias hábiles aproximadamente.`

/** Un cuestionario ya en la etapa de material, con un examen chico: dos secciones. */
function estadoEnMaterial(): EstadoCuestionario {
  const estado = estadoInicial('Tapicería Norte')
  estado.etapa = 'material'
  estado.clasificacion = { accionTerminal: 'seña pagada', arquetipo: 'A', hibrido: false, procesos: [], mensaje: 'ok' }
  estado.examen = {
    negocio: 'Tapicería Norte',
    arquetipo: 'A',
    accionTerminal: 'seña pagada',
    nota: null,
    material: ['Un chat que terminó en seña', 'Uno que preguntó y no compró', 'Uno que quedó colgado'],
    secciones: [
      {
        numero: 1,
        titulo: 'Qué ofrecés',
        preguntas: [
          { id: '1.1', texto: '¿Cuánto tarda la confección? Poné el número.' },
          { id: '1.2', texto: '¿Qué productos vendés? Listalos.' },
        ],
      },
      { numero: 5, titulo: 'Preguntas que te hacen siempre', preguntas: [{ id: '5.1', texto: 'Pegá cómo respondés si preguntan si hacen fundas en tela.' }] },
    ],
  }
  return estado
}

const aceptar: SalidaEvaluacionEntrevista = { decision: 'aceptar', repregunta: '', nota: '', responde_como_agente: false, es_plan: false }

function cierre(preguntas: number): SalidaCierre {
  return {
    estilo: 'Mensajes cortos, vosea, usa emojis.',
    contradicciones: [{ detalle: 'Dijo que no da precio de entrada; en el guion va primero.', pregunta: 'En tu guion el precio va en el primer mensaje. ¿Hoy es así?' }],
    cobertura: [{ campo: 'Qué necesita saber la persona', estado: 'completo', detalle: 'Oferta y plazos' }],
    simulaciones: [{ titulo: 'Fácil', conversacion: 'Cliente: hola\nNegocio: hola' }],
    agujeros: [{ detalle: 'No está el plazo de envío', pregunta: '¿Cuánto tarda el envío al interior?' }],
    preguntas_finales: Array.from({ length: preguntas }, (_, i) => ({ texto: `Pregunta final ${i + 1}`, motivo: 'agujero' })),
  }
}

const briefFinal: SalidaBriefFinal = { brief: '# Brief Comercial — Tapicería Norte', claude: '# Tapicería Norte', pendientes: ['Plazo de envío: el agente no puede contestarlo'] }

describe('triage', () => {
  it('arranca en la pregunta 1 con la introducción de la skill', () => {
    const pantalla = pantallaActual(estadoInicial('Clínica'))
    assert.ok(pantalla.tipo === 'pregunta')
    assert.equal(pantalla.introduccion, textos.INTRODUCCION_TRIAGE)
    assert.equal(pantalla.texto, textos.PREGUNTAS_TRIAGE[0].texto)
  })

  it('un índice guardado más allá de la última pregunta muestra la última', () => {
    // Pasa si el formulario pierde una pregunta con un cuestionario a mitad del triage.
    const estado = estadoInicial('Clínica')
    estado.triage.indice = textos.PREGUNTAS_TRIAGE.length
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'pregunta')
    assert.equal(pantalla.texto, textos.PREGUNTAS_TRIAGE[textos.PREGUNTAS_TRIAGE.length - 1].texto)
  })

  it('en la pregunta 1 repregunta con el texto de la skill y una sola vez', async () => {
    const ia = iaFalsa({ evaluar_triage: [{ decision: 'repreguntar', repregunta: 'otra cosa' }] })
    let estado = await avanzar(estadoInicial('Clínica'), respuesta('terminó bien'), dependencias(ia))
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'pregunta')
    assert.equal(pantalla.texto, textos.REPREGUNTA_ACCION_TERMINAL)
    assert.equal(pantalla.esRepregunta, true)

    estado = await avanzar(estado, respuesta('le mandé el link'), dependencias(ia))
    assert.equal(estado.triage.indice, 1)
    assert.equal(estado.triage.intercambios.length, 2)
    assert.equal(pasos(ia).filter((p) => p === 'evaluar_triage').length, 1)
  })

  it('con las respuestas del triage y material suficiente pasa a confirmar la clasificación', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple] })
    const estado = await aplicar(estadoInicial('Clínica'), respuestasDelTriage, dependencias(ia))
    assert.equal(estado.etapa, 'confirmacion')
    assert.deepEqual(pantallaActual(estado), { tipo: 'confirmacion', texto: clasificacionSimple.mensaje })
  })

  it('manda la skill que corresponde y la capa web como sistema', async () => {
    const ia = iaFalsa({ evaluar_triage: [seguir] })
    await avanzar(estadoInicial('Clínica'), respuesta('pagó'), dependencias(ia))
    assert.equal(ia.pedidos[0].sistema[0], 'TEXTO DE LA SKILL mi-negocio')
    assert.match(ia.pedidos[0].sistema[1], /Reglas del canal web/)
  })
})

describe('Fase 0.5', () => {
  it('si no alcanza pide un chat; sin chats reconstruye con tres preguntas y clasifica', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [noAlcanza], clasificar: [clasificacionSimple] })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Cerrajería'), respuestasDelTriage, dep)
    assert.equal(estado.etapa, 'pedido_chat')

    estado = await avanzar(estado, { tipo: 'sin_chat' }, dep)
    assert.equal(estado.etapa, 'reconstruccion')
    for (const texto of textos.PREGUNTAS_RECONSTRUCCION) {
      const pantalla = pantallaActual(estado)
      assert.ok(pantalla.tipo === 'pregunta')
      assert.equal(pantalla.texto, texto)
      estado = await avanzar(estado, respuesta('no me acuerdo'), dep)
    }
    assert.equal(estado.etapa, 'confirmacion')
  })

  it('con capturas subidas y sin texto, las transcribe y las usa como chat', async () => {
    const ia = iaFalsa({
      evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir),
      evaluar_alcance: [noAlcanza],
      transcribir_archivo: [{ texto: 'Cliente: se me trabó la puerta' }],
      clasificar: [clasificacionSimple],
    })
    const dep = dependencias(ia, { captura: Buffer.from([0xff, 0xd8, 0xff]) })
    let estado = await aplicar(estadoInicial('Cerrajería'), respuestasDelTriage, dep)
    estado.material.archivos.push({ id: 'captura', nombre: 'chat.jpg', mime: 'image/jpeg', tipo: 'imagen', bytes: 3, texto: null, etapa: 'pedido_chat' })

    await assert.rejects(avanzar({ ...estado, material: { ...estado.material, archivos: [] } }, respuesta(''), dep), ErrorEntrada)
    estado = await avanzar(estado, respuesta(''), dep)

    assert.equal(estado.etapa, 'confirmacion')
    assert.match(estado.chat ?? '', /Cliente: se me trabó la puerta/)
    const transcripcion = ia.pedidos.find((p) => p.paso === 'transcribir_archivo')!
    assert.ok(Array.isArray(transcripcion.mensaje) && transcripcion.mensaje[0].type === 'image')
  })
})

describe('Fase 1', () => {
  it('si hay dos procesos hace elegir y reclasifica con el elegido', async () => {
    const hibrido: SalidaClasificacion = { ...clasificacionSimple, hibrido: true, procesos: ['vender el plan', 'agendar la clase de prueba'], mensaje: '' }
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [alcanza], clasificar: [hibrido, clasificacionSimple] })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Gimnasio'), respuestasDelTriage, dep)
    assert.deepEqual(pantallaActual(estado), { tipo: 'eleccion', texto: textos.ELECCION_HIBRIDO, opciones: hibrido.procesos })

    await assert.rejects(avanzar(estado, { tipo: 'eleccion', opcion: 'otra' }, dep), ErrorEntrada)
    estado = await avanzar(estado, { tipo: 'eleccion', opcion: 'agendar la clase de prueba' }, dep)
    assert.equal(estado.etapa, 'confirmacion')
    assert.equal(estado.procesoElegido, 'agendar la clase de prueba')
  })

  it('una corrección se guarda y reclasifica', async () => {
    const ia = iaFalsa({
      evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple, { ...clasificacionSimple, arquetipo: 'A' }],
    })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Clínica'), respuestasDelTriage, dep)
    estado = await avanzar(estado, { tipo: 'corregir', texto: 'No, el chat termina cuando pagan la seña' }, dep)
    assert.deepEqual(estado.correcciones, ['No, el chat termina cuando pagan la seña'])
    assert.equal(estado.clasificacion?.arquetipo, 'A')
  })

  it('saca el rótulo "Acción terminal del chat bueno:" si el modelo lo copia en el valor', async () => {
    const conRotulo: SalidaClasificacion = { ...clasificacionSimple, accion_terminal: 'Acción terminal del chat bueno: le paso la dirección y quedamos en un horario' }
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [alcanza], clasificar: [conRotulo] })
    const estado = await aplicar(estadoInicial('Cerrajería'), respuestasDelTriage, dependencias(ia))
    assert.equal(estado.clasificacion?.accionTerminal, 'le paso la dirección y quedamos en un horario')
  })
})

describe('generación del examen', () => {
  const hastaConfirmar = (ia: ClienteIa) => aplicar(estadoInicial('Clínica'), respuestasDelTriage, dependencias(ia))

  it('si la validación falla, reintenta con los errores y se queda con la versión válida', async () => {
    const invalido = examenValido()
    invalido.secciones[0].preguntas[0] = 'Contá cómo es tu día.'
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple], generar_examen: [invalido, examenValido()] })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))

    assert.equal(estado.etapa, 'material')
    assert.deepEqual(estado.pendientesExamen, [])
    assert.equal(pasos(ia).filter((p) => p === 'generar_examen').length, 2)
    assert.match(ia.pedidos.filter((p) => p.paso === 'generar_examen')[1].mensaje as string, /verbo que pide narración/)
    assert.ok(estado.avisos.some((a) => a.startsWith('Intento 1 del cuestionario rechazado')))
  })

  it('después de los reintentos sigue igual y deja los errores pendientes', async () => {
    const invalido = examenValido()
    invalido.secciones[7].preguntas = ['¿A quién derivás? Nombralo.']
    const ia = iaFalsa({
      evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple],
      generar_examen: Array.from({ length: INTENTOS_EXAMEN }, () => invalido),
    })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))
    assert.equal(estado.etapa, 'material')
    assert.ok(estado.pendientesExamen.some((e) => e.startsWith('Falta en la sección 8')))
  })

  it('la nota del cuestionario general queda con el texto exacto de la skill', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(textos.PREGUNTAS_TRIAGE.length).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple], generar_examen: [{ ...examenValido(), nota: 'Es general.' }] })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))
    assert.equal(estado.examen?.nota, textos.NOTA_GENERICO)
  })
})

describe('material', () => {
  it('pegar y quitar textos no llama a la IA', async () => {
    const ia = iaFalsa({})
    const dep = dependencias(ia)
    let estado = await avanzar(estadoEnMaterial(), { tipo: 'texto_material', texto: GUION }, dep)
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'material')
    assert.equal(pantalla.textos.length, 1)
    estado = await avanzar(estado, { tipo: 'quitar_texto', id: estado.material.textos[0].id }, dep)
    assert.equal(estado.material.textos.length, 0)
    assert.equal(ia.pedidos.length, 0)
  })

  it('sin material avisa una vez y a la segunda sigue, dejándolo en los avisos', async () => {
    const ia = iaFalsa({})
    const dep = dependencias(ia)
    let estado = await avanzar(estadoEnMaterial(), { tipo: 'terminar_material' }, dep)
    assert.equal(estado.etapa, 'material')
    assert.equal(estado.material.avisoFaltantes, textos.AVISO_SIN_MATERIAL)

    estado = await avanzar(estado, { tipo: 'terminar_material' }, dep)
    assert.equal(estado.etapa, 'entrevista')
    assert.ok(estado.avisos.some((a) => a.includes('sin material')))
    assert.equal(ia.pedidos.length, 0)
  })

  it('con material: avisa lo que falta una vez, después propone solo lo que está escrito tal cual', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: ['el chat de alguien que no compró'] }],
      proponer_respuestas: [
        {
          propuestas: [
            { id: '1.1', texto: 'El tiempo de fabricación es de 5 dias hábiles aproximadamente.', fuente: 'Texto pegado 1' },
            { id: '1.2', texto: 'Vendemos fundas y alfombras', fuente: 'Texto pegado 1' },
            { id: '9.9', texto: 'El tiempo de confección', fuente: 'Texto pegado 1' },
          ],
        },
      ],
    })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoEnMaterial(), [{ tipo: 'texto_material', texto: GUION }, { tipo: 'terminar_material' }], dep)
    assert.equal(estado.etapa, 'material')
    assert.match(estado.material.avisoFaltantes ?? '', /el chat de alguien que no compró/)

    estado = await avanzar(estado, { tipo: 'terminar_material' }, dep)
    assert.equal(estado.etapa, 'entrevista')
    assert.deepEqual(Object.keys(estado.entrevista.propuestas), ['1.1'])
    assert.deepEqual(pasos(ia), ['revisar_material', 'proponer_respuestas'])
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'entrevista')
    assert.equal(pantalla.propuesta?.texto, 'El tiempo de fabricación es de 5 dias hábiles aproximadamente.')
  })

  it('una respuesta repartida en el material se propone por pedazos y cada pedazo tiene que estar tal cual', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        {
          propuestas: [
            { id: '1.1', texto: 'Te mando un video corto con las diferencias entre los modelos. [...] El tiempo de fabricación es de 5 dias hábiles aproximadamente.', fuente: 'Texto pegado 1' },
            { id: '1.2', texto: 'Trabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años.\n[…]\nTambién hacemos alfombras.', fuente: 'Texto pegado 1' },
          ],
        },
      ],
    })
    const estado = await aplicar(estadoEnMaterial(), [{ tipo: 'texto_material', texto: GUION }, { tipo: 'terminar_material' }], dependencias(ia))
    assert.equal(estado.etapa, 'entrevista')
    assert.deepEqual(Object.keys(estado.entrevista.propuestas), ['1.1'])
    assert.equal(
      estado.entrevista.propuestas['1.1'].texto,
      'Te mando un video corto con las diferencias entre los modelos.\n\n[…]\n\nEl tiempo de fabricación es de 5 dias hábiles aproximadamente.',
    )
  })

  it('transcribe los archivos que no tienen texto antes de revisar', async () => {
    const ia = iaFalsa({ transcribir_archivo: [{ texto: GUION }], revisar_material: [{ faltan: [] }], proponer_respuestas: [{ propuestas: [] }] })
    const estado = estadoEnMaterial()
    estado.material.archivos.push({ id: 'pdf1', nombre: 'guion.pdf', mime: 'application/pdf', tipo: 'pdf', bytes: 10, texto: null, etapa: 'material' })
    const siguiente = await avanzar(estado, { tipo: 'terminar_material' }, dependencias(ia))
    assert.equal(siguiente.material.archivos[0].texto, GUION)
    assert.equal(siguiente.etapa, 'entrevista')
    const pedido = ia.pedidos.find((p) => p.paso === 'transcribir_archivo')!
    assert.ok(Array.isArray(pedido.mensaje) && pedido.mensaje[0].type === 'document')
  })

  it('una misma pregunta propuesta en varios pedazos se junta en vez de quedarse con el último', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        {
          propuestas: [
            { id: '1.2', texto: 'Te mando un video corto con las diferencias entre los modelos.', fuente: 'Texto pegado 1' },
            { id: '1.2', texto: 'Trabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años.', fuente: 'Texto pegado 1' },
            { id: '1.2', texto: 'Esto no está en el material', fuente: 'Texto pegado 1' },
          ],
        },
      ],
    })
    const estado = await aplicar(estadoEnMaterial(), [{ tipo: 'texto_material', texto: GUION }, { tipo: 'terminar_material' }], dependencias(ia))
    assert.equal(
      estado.entrevista.propuestas['1.2'].texto,
      'Te mando un video corto con las diferencias entre los modelos.\n\n[…]\n\nTrabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años.',
    )
  })
})

describe('archivos que Claude no puede leer', () => {
  function conArchivos(...archivos: [id: string, tipo: 'imagen' | 'pdf'][]): EstadoCuestionario {
    const estado = estadoEnMaterial()
    for (const [id, tipo] of archivos) {
      estado.material.archivos.push({
        id,
        nombre: `${id}.${tipo === 'pdf' ? 'pdf' : 'png'}`,
        mime: tipo === 'pdf' ? 'application/pdf' : 'image/png',
        tipo,
        bytes: 10,
        texto: null,
        etapa: 'material',
      })
    }
    return estado
  }

  /** Transcribe según el archivo: cada id elige qué le pasa. */
  function iaPorArchivo(resultados: Record<string, () => unknown>, resto: Record<string, unknown[]> = {}) {
    const base = iaFalsa(resto)
    return {
      ...base,
      async pedirJson<T>(pedido: PedidoJson): Promise<T> {
        if (pedido.paso !== 'transcribir_archivo') return base.pedirJson<T>(pedido)
        base.pedidos.push(pedido)
        const texto = (pedido.mensaje as { type: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? ''
        const id = /Archivo: (\S+)\./.exec(texto)?.[1] ?? ''
        return resultados[id]() as T
      },
    }
  }

  it('un PDF que se corta por largo guarda lo que alcanzó a leer, avisa y sigue sin volver a leerlo', async () => {
    const ia = iaPorArchivo(
      {
        catalogo: () => {
          throw new ErrorIa('se cortó', 'cortada', '{"texto": "Lista de precios\\nModelo A: $100\\nModelo B: $2')
        },
        chat: () => ({ texto: 'Cliente: hola' }),
      },
      { revisar_material: [{ faltan: [] }], proponer_respuestas: [{ propuestas: [] }] },
    )
    let estado = await avanzar(conArchivos(['catalogo', 'pdf'], ['chat', 'imagen']), { tipo: 'terminar_material' }, dependencias(ia))

    // Se queda en el material para que vea la nota del archivo, con todo lo leído guardado.
    assert.equal(estado.etapa, 'material')
    const [catalogo, chat] = estado.material.archivos
    assert.ok(catalogo.texto?.startsWith('Lista de precios\nModelo A: $100\n'))
    // La línea cortada a mitad de un precio no queda como si fuera un dato.
    assert.ok(!catalogo.texto?.includes('Modelo B: $2'))
    assert.match(catalogo.texto ?? '', /se cortó/i)
    assert.ok(catalogo.problema)
    assert.equal(chat.texto, 'Cliente: hola')
    assert.equal(chat.problema, undefined)
    assert.ok(estado.avisos.some((a) => a.includes('catalogo.pdf')))
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'material')
    assert.ok(pantalla.archivos.find((a) => a.id === 'catalogo')?.problema)

    estado = await avanzar(estado, { tipo: 'terminar_material' }, dependencias(ia))
    assert.equal(estado.etapa, 'entrevista')
    assert.equal(pasos(ia).filter((p) => p === 'transcribir_archivo').length, 2)
  })

  it('una imagen rechazada, una cortada o un archivo que ya no está quedan sin leer y el resto se guarda', async () => {
    const ia = iaPorArchivo({
      pesada: () => {
        throw new ErrorIa('image exceeds 10 MB maximum', 'invalido')
      },
      enganchada: () => {
        throw new ErrorIa('se cortó', 'cortada', '{"texto": "hola hola hola hola')
      },
      buena: () => ({ texto: 'Cliente: ¿tienen turno el sábado?' }),
    })
    const dep = dependencias(ia)
    dep.imagenParaClaude = async (archivo) => {
      if (archivo.id === 'borrada') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      return { datos: Buffer.from('contenido'), mime: 'image/png' }
    }
    const estado = await avanzar(
      conArchivos(['pesada', 'imagen'], ['enganchada', 'imagen'], ['borrada', 'imagen'], ['buena', 'imagen']),
      { tipo: 'terminar_material' },
      dep,
    )
    assert.equal(estado.etapa, 'material')
    const porId = Object.fromEntries(estado.material.archivos.map((a) => [a.id, a]))
    for (const id of ['pesada', 'enganchada', 'borrada']) {
      // Texto vacío y no null: no se vuelve a intentar en cada «Seguir».
      assert.equal(porId[id].texto, '', id)
      assert.ok(porId[id].problema, id)
      assert.ok(estado.avisos.some((a) => a.includes(porId[id].nombre)), id)
    }
    assert.equal(porId.buena.texto, 'Cliente: ¿tienen turno el sábado?')
  })

  it('un error pasajero frena el paso sin arrancar más transcripciones', async () => {
    let llamadas = 0
    const ia: ClienteIa = {
      modelo: 'falso',
      async pedirJson<T>(): Promise<T> {
        llamadas++
        if (llamadas === 1) throw new ErrorIa('overloaded', 'api')
        return { texto: 'Cliente: hola' } as T
      },
    }
    const estado = conArchivos(['a', 'imagen'], ['b', 'imagen'], ['c', 'imagen'], ['d', 'imagen'], ['e', 'imagen'], ['f', 'imagen'])
    await assert.rejects(avanzar(estado, { tipo: 'terminar_material' }, dependencias(ia)), ErrorIa)
    // Las cuatro que ya habían arrancado terminan; las otras dos no se piden.
    assert.equal(llamadas, 4)
  })

  it('en el pedido de chat, una captura que no se lee no frena la clasificación', async () => {
    const ia = iaPorArchivo(
      {
        rota: () => {
          throw new ErrorIa('Could not process image', 'invalido')
        },
      },
      { clasificar: [clasificacionSimple] },
    )
    const estado = estadoInicial('Clínica')
    estado.etapa = 'pedido_chat'
    estado.material.archivos.push({ id: 'rota', nombre: 'rota.png', mime: 'image/png', tipo: 'imagen', bytes: 10, texto: null, etapa: 'pedido_chat' })
    const siguiente = await avanzar(estado, respuesta('Cliente: quiero un turno'), dependencias(ia))
    assert.equal(siguiente.etapa, 'confirmacion')
    assert.equal(siguiente.chat, 'Cliente: quiero un turno')
    assert.ok(siguiente.avisos.some((a) => a.includes('rota.png')))

    // Sin texto y sin ninguna captura legible es como no tener el chat: se reconstruye.
    const sinNada = await avanzar(estado, respuesta(''), dependencias(iaPorArchivo({ rota: () => { throw new ErrorIa('Could not process image', 'invalido') } })))
    assert.equal(sinNada.etapa, 'reconstruccion')
    assert.equal(sinNada.chat, null)
  })
})

describe('entrevista', () => {
  async function enEntrevista(ia: ClienteIa) {
    const dep = dependencias(ia)
    const estado = await aplicar(estadoEnMaterial(), [{ tipo: 'texto_material', texto: GUION }, { tipo: 'terminar_material' }], dep)
    return { estado, dep }
  }

  it('recorre la sección con propuesta, repregunta, "no lo sé" y escribe el brief de la sección', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        { propuestas: [{ id: '1.1', texto: 'El tiempo de fabricación es de 5 dias hábiles aproximadamente.', fuente: 'Texto pegado 1' }] },
        { propuestas: [] },
      ],
      evaluar_respuesta: [{ ...aceptar, decision: 'repreguntar', repregunta: '¿Cuáles, puntualmente?' }, { ...aceptar, decision: 'repreguntar', repregunta: 'otra vez' }],
      escribir_seccion_brief: [{ markdown: '## 1. Oferta\n- Confección: 7 días hábiles' }],
    })
    let { estado, dep } = await enEntrevista(ia)

    estado = await avanzar(estado, { tipo: 'sigue_igual' }, dep)
    assert.equal(estado.entrevista.respuestas['1.1'].sigueIgual, true)
    assert.equal(estado.entrevista.indice, 1)
    await assert.rejects(avanzar(estado, { tipo: 'sigue_igual' }, dep), ErrorEntrada)

    estado = await avanzar(estado, respuesta('de todo'), dep)
    const conRepregunta = pantallaActual(estado)
    assert.ok(conRepregunta.tipo === 'entrevista')
    assert.equal(conRepregunta.repregunta, '¿Cuáles, puntualmente?')

    // Vaga otra vez después de repreguntar: queda pendiente y no se repregunta de nuevo.
    estado = await avanzar(estado, respuesta('de todo un poco'), dep)
    assert.equal(estado.entrevista.respuestas['1.2'].estado, 'pendiente')
    assert.equal(estado.entrevista.respuestas['1.2'].intercambios.length, 2)

    assert.equal(estado.entrevista.seccion, 5)
    assert.equal(estado.entrevista.brief['1'], '## 1. Oferta\n- Confección: 7 días hábiles')
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'entrevista')
    assert.equal(pantalla.formato, 'texto_literal')
    assert.equal(pasos(ia).filter((p) => p === 'proponer_respuestas').length, 2)
  })

  it('si contesta como el bot, repregunta con la frase de la skill', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [{ propuestas: [] }],
      evaluar_respuesta: [{ ...aceptar, decision: 'aceptar', responde_como_agente: true }],
    })
    let { estado, dep } = await enEntrevista(ia)
    estado = await avanzar(estado, respuesta('el bot debería decir que tardamos una semana'), dep)
    assert.equal(estado.entrevista.repregunta, textos.FRASE_RESPONDE_COMO_AGENTE)
  })

  it('"no aplica" pide motivo y no llama a la IA', async () => {
    const ia = iaFalsa({ revisar_material: [{ faltan: [] }], proponer_respuestas: [{ propuestas: [] }] })
    let { estado, dep } = await enEntrevista(ia)
    await assert.rejects(avanzar(estado, { tipo: 'no_aplica', texto: ' ' }, dep), ErrorEntrada)
    estado = await avanzar(estado, { tipo: 'no_aplica', texto: 'no hacemos confección propia' }, dep)
    assert.equal(estado.entrevista.respuestas['1.1'].estado, 'no_aplica')
    assert.equal(estado.entrevista.respuestas['1.1'].nota, 'no hacemos confección propia')
    assert.equal(pasos(ia).filter((p) => p === 'evaluar_respuesta').length, 0)
  })

  it('en una sección literal reintenta el brief si cita algo que el dueño no dijo', async () => {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [{ propuestas: [] }, { propuestas: [] }],
      evaluar_respuesta: [aceptar],
      escribir_seccion_brief: [
        { markdown: '## 1. Oferta' },
        { markdown: '## 5. Preguntas frecuentes\nR: "Hacemos fundas de tela y de cuero, las dos opciones"' },
        { markdown: '## 5. Preguntas frecuentes\nR: "Trabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años."' },
      ],
      analizar_cierre: [cierre(0)],
      cerrar_brief: [briefFinal],
    })
    let { estado, dep } = await enEntrevista(ia)
    estado = await aplicar(estado, [{ tipo: 'no_se' }, { tipo: 'no_se' }, respuesta('Trabajamos solo con cuero ecológico resistente al agua y al sol, para que dure años.')], dep)

    const escrituras = ia.pedidos.filter((p) => p.paso === 'escribir_seccion_brief')
    assert.equal(escrituras.length, 3)
    assert.match(JSON.stringify(escrituras[2].mensaje), /no aparecen tal cual/)
    assert.match(estado.entrevista.brief['5'], /Trabajamos solo con cuero/)
    assert.equal(estado.avisos.filter((a) => a.startsWith('Sección 5 del brief')).length, 0)
  })
})

describe('cierre y entregables', () => {
  async function hastaUltimaRespuesta(preguntasFinales: number) {
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        { propuestas: [{ id: '1.1', texto: 'El tiempo de fabricación es de 5 dias hábiles aproximadamente.', fuente: 'Texto pegado 1' }] },
        { propuestas: [] },
      ],
      evaluar_respuesta: [aceptar, { ...aceptar, es_plan: true }],
      escribir_seccion_brief: [{ markdown: '## 1. Oferta' }, { markdown: '## 5. Preguntas frecuentes' }],
      analizar_cierre: [cierre(preguntasFinales)],
      cerrar_brief: [briefFinal],
    })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoEnMaterial(), [{ tipo: 'texto_material', texto: GUION }, { tipo: 'terminar_material' }], dep)
    estado = await aplicar(estado, [respuesta('Ahora son 10 días hábiles'), respuesta('Fundas y alfombras'), { tipo: 'no_se' }], dep)
    return { estado, dep, ia }
  }

  it('con preguntas finales las hace de a una (máximo 8) y después arma los entregables', async () => {
    let { estado, dep, ia } = await hastaUltimaRespuesta(10)
    assert.equal(estado.etapa, 'preguntas_finales')
    assert.equal(estado.preguntasFinales.length, MAXIMO_PREGUNTAS_FINALES)
    assert.deepEqual(pantallaActual(estado), { tipo: 'pregunta_final', numero: 1, total: 8, texto: 'Pregunta final 1' })

    for (let i = 0; i < MAXIMO_PREGUNTAS_FINALES - 1; i++) estado = await avanzar(estado, respuesta(`respuesta ${i + 1}`), dep)
    assert.equal(estado.etapa, 'preguntas_finales')
    estado = await avanzar(estado, { tipo: 'no_se' }, dep)

    assert.equal(estado.etapa, 'terminado')
    assert.deepEqual(pantallaActual(estado), { tipo: 'gracias', texto: textos.GRACIAS })
    assert.equal(progreso(estado).porcentaje, 100)
    const e = estado.entregables!
    assert.match(e.examen, /^# Cuestionario — Tapicería Norte/)
    assert.equal(e.brief, '# Brief Comercial — Tapicería Norte\n')
    assert.match(e.cierre, /## Lo que contestó distinto de su material/)
    assert.match(e.cierre, /Su material \(Texto pegado 1\): "El tiempo de fabricación es de 5 dias hábiles aproximadamente."/)
    assert.match(e.cierre, /Contestó: "Ahora son 10 días hábiles"/)
    // Qué se le manda al escribir el brief: nunca que "cambió".
    const escritura = ia.pedidos.filter((p) => p.paso === 'escribir_seccion_brief')[0]
    assert.doesNotMatch(JSON.stringify(escritura.mensaje), /[Cc]ontestó que cambió/)
    assert.match(e.cierre, /## Planes, no práctica\n\n- 1\.2/)
    assert.match(e.cierre, /\[PENDIENTE: no lo sabe\]/)
    assert.match(JSON.stringify(ia.pedidos.find((p) => p.paso === 'cerrar_brief')!.mensaje), /Pregunta final 8/)
    await assert.rejects(avanzar(estado, respuesta('algo más'), dep), ErrorEntrada)
  })

  it('sin preguntas finales va directo a los entregables', async () => {
    const { estado } = await hastaUltimaRespuesta(0)
    assert.equal(estado.etapa, 'terminado')
    assert.ok(estado.entregables)
  })
})

describe('robustez', () => {
  it('si la IA falla a mitad de camino, el estado guardado no cambia', async () => {
    const ia: ClienteIa = {
      modelo: 'falso',
      async pedirJson() {
        throw new ErrorIa('se cayó la API', 'api')
      },
    }
    const guardado = estadoInicial('Clínica')
    const copia = structuredClone(guardado)
    await assert.rejects(avanzar(guardado, respuesta('pagó'), dependencias(ia)), ErrorIa)
    assert.deepEqual(guardado, copia)
  })

  it('rechaza entradas que no corresponden a la etapa', async () => {
    const ia = iaFalsa({})
    await assert.rejects(avanzar(estadoInicial('Clínica'), { tipo: 'confirmar' }, dependencias(ia)), ErrorEntrada)
    await assert.rejects(avanzar(estadoInicial('Clínica'), respuesta('   '), dependencias(ia)), ErrorEntrada)
    await assert.rejects(avanzar(estadoEnMaterial(), respuesta('hola'), dependencias(ia)), ErrorEntrada)
  })
})

// ---------------------------------------------------------------------------------------------
// Conversaciones, audios y videos. Todo inventado: los chats imitan el formato de WhatsApp.
// ---------------------------------------------------------------------------------------------

const CHAT_DE_LAURA = `[16/9/26, 10:05:44] Laura: Hola! Precio de fundas para Gol Trend?
[16/9/26, 10:06:10] Tapicería Norte: <adjunto: 00000043-AUDIO.opus>
[16/9/26, 11:14:26] Tapicería Norte: Así quedan con el vivo rojo <adjunto: 00000056-PHOTO.jpg>
[16/9/26, 12:09:30] Tapicería Norte: Y así el cubrevolante <adjunto: 00000084-VIDEO.mp4>`

let numeroDeArchivo = 0
function subido(nombre: string, tipo: ArchivoMaterial['tipo'], mas: Partial<ArchivoMaterial> = {}): ArchivoMaterial {
  numeroDeArchivo++
  return { id: `f${numeroDeArchivo}`, nombre, mime: 'x/x', tipo, bytes: 10, texto: null, etapa: 'material', hash: `hash-${numeroDeArchivo}`, ...mas }
}

/** Una conversación como la deja el .zip de WhatsApp: el chat ya leído y sus adjuntos por leer. */
function conversacionDeLaura(grupo = 'Venta cerrada - Laura'): ArchivoMaterial[] {
  return [
    subido('_chat.txt', 'texto', { texto: CHAT_DE_LAURA, grupo }),
    subido('00000043-AUDIO.opus', 'audio', { grupo }),
    subido('00000056-PHOTO.jpg', 'imagen', { grupo }),
    subido('00000084-VIDEO.mp4', 'video', { grupo }),
  ]
}

function conMaterial(...archivos: ArchivoMaterial[]): EstadoCuestionario {
  const estado = estadoEnMaterial()
  estado.material.archivos.push(...archivos)
  return estado
}

/** Una por prueba: la IA falsa va gastando las respuestas. */
const sinFaltantes = () => ({ revisar_material: [{ faltan: [] }], proponer_respuestas: [{ propuestas: [] }] })
const terminarMaterial: Entrada = { tipo: 'terminar_material' }
const textoDe = (pedido: PedidoJson) => (pedido.mensaje as { type: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? ''
const materialQueVeClaude = (ia: { pedidos: PedidoJson[] }) => JSON.stringify(ia.pedidos.find((p) => p.paso === 'proponer_respuestas')!.mensaje)

describe('audios, fotos y videos de una conversación', () => {
  it('cada adjunto se lee y queda en su lugar del chat, con lo automático marcado', async () => {
    const ia = iaFalsa({
      transcribir_archivo: [{ texto: '', descripcion: 'Asiento delantero con funda negra y costura roja.' }],
      describir_video: [{ descripcion: 'Una mano muestra un cubrevolante negro.' }],
      ...sinFaltantes(),
    })
    const dep = dependencias(ia)
    dep.transcribirAudio = async (archivo) =>
      archivo.tipo === 'video' ? escucha('este es el cubrevolante', { segundos: 68 }) : escucha('Hola Laura, salen 80 mil de lista.')
    const estado = await avanzar(conMaterial(...conversacionDeLaura()), terminarMaterial, dep)

    assert.equal(estado.etapa, 'entrevista')
    const [, audio, foto, video] = estado.material.archivos
    assert.deepEqual([audio.texto, audio.duracion, audio.problema], ['Hola Laura, salen 80 mil de lista.', 13, undefined])
    assert.deepEqual([foto.texto, foto.descripcion], ['', 'Asiento delantero con funda negra y costura roja.'])
    assert.equal(video.texto, 'Se ve: Una mano muestra un cubrevolante negro.\nSe escucha: este es el cubrevolante')
    assert.equal(video.duracion, 68)

    // A Claude se le dice en qué conversación y en qué momento se mandó cada cosa.
    const foto_ = ia.pedidos.find((p) => p.paso === 'transcribir_archivo')!
    assert.match(textoDe(foto_), /^PASO: transcribir material que subió el dueño\. Archivo: 00000056-PHOTO\.jpg\n/)
    assert.match(textoDe(foto_), /Se mandó en la conversación «Venta cerrada - Laura», en este momento del chat:\n.*\n.*\n.*Así quedan con el vivo rojo/)
    const delVideo = ia.pedidos.find((p) => p.paso === 'describir_video')!
    const bloques = delVideo.mensaje as { type: string }[]
    assert.deepEqual(bloques.map((b) => b.type), ['image', 'image', 'text'])
    assert.match(textoDe(delVideo), /Archivo: 00000084-VIDEO\.mp4\n[\s\S]*Son 2 fotogramas parejos de un video de 47 segundos/)

    // Lo que lee Claude en la entrevista: una conversación, con cada adjunto donde se mandó.
    const material = JSON.parse(materialQueVeClaude(ia))[0].text as string
    assert.match(material, /## Conversación: Venta cerrada - Laura\n\(4 archivos: el chat, 1 audio, 1 foto, 1 video\)/)
    assert.match(material, /Tapicería Norte: \[Audio «00000043-AUDIO\.opus», 0:13, transcripción automática: ⟪Hola Laura, salen 80 mil de lista\.⟫\]/)
    assert.match(material, /Así quedan con el vivo rojo \[Foto «00000056-PHOTO\.jpg»: ⟪Asiento delantero con funda negra y costura roja\.⟫\]/)
    assert.match(material, /\[Video «00000084-VIDEO\.mp4», 1:08, descripción y transcripción automáticas: ⟪Se ve: Una mano/)
    assert.match(ia.pedidos.find((p) => p.paso === 'proponer_respuestas')!.sistema[1], /El material viene separado por conversación/)
  })

  it('un audio sin voz, uno recortado y uno dudoso quedan dichos', async () => {
    const ia = iaFalsa(sinFaltantes())
    const dep = dependencias(ia)
    const resultados: Record<string, Transcripcion> = {
      'silencio.opus': escucha('', { sinVoz: true, segundos: 8 }),
      'largo.opus': escucha('hablamos mucho', { recortada: true, segundos: 1200 }),
      'ruido.opus': escucha('de la', { dudosa: true }),
    }
    dep.transcribirAudio = async (archivo) => resultados[archivo.nombre]
    const estado = await avanzar(conMaterial(subido('silencio.opus', 'audio'), subido('largo.opus', 'audio'), subido('ruido.opus', 'audio')), terminarMaterial, dep)
    const [silencio, largo, ruido] = estado.material.archivos
    assert.equal(silencio.texto, textos.TEXTO_SIN_VOZ)
    assert.equal(largo.texto, 'hablamos mucho (se escucharon los primeros 15 minutos)')
    assert.deepEqual([ruido.texto, ruido.dudosa], ['de la', true])
    assert.match(JSON.parse(materialQueVeClaude(ia))[0].text, /### ruido\.opus\nAudio, 0:13, transcripción automática, puede tener errores: ⟪de la⟫/)
  })

  it('un video sin imagen se trata como audio y no se le pide nada a Claude', async () => {
    const ia = iaFalsa(sinFaltantes())
    const dep = dependencias(ia)
    dep.fotogramasDeVideo = async () => ({ cuadros: [], segundos: 21, tieneVideo: false, tieneAudio: true })
    const estado = await avanzar(conMaterial(subido('nota de voz.mp4', 'video')), terminarMaterial, dep)
    const [nota] = estado.material.archivos
    assert.deepEqual([nota.tipo, nota.texto], ['audio', 'transcripción de nota de voz.mp4'])
    assert.ok(!pasos(ia).includes('describir_video'))
  })

  it('el mismo archivo en dos conversaciones se mira y se escucha una sola vez', async () => {
    const ia = iaFalsa({ describir_video: [{ descripcion: 'Un auto con fundas.' }], transcribir_archivo: [{ texto: 'Lista de precios' }], ...sinFaltantes() })
    const dep = dependencias(ia)
    let escuchas = 0
    dep.transcribirAudio = async () => {
      escuchas++
      return escucha('así queda')
    }
    const estado = await avanzar(
      conMaterial(
        subido('video.mp4', 'video', { grupo: 'Ana', hash: 'mismo-video' }),
        subido('00000007-VIDEO.mp4', 'video', { grupo: 'Beto', hash: 'mismo-video' }),
        subido('lista.pdf', 'pdf', { grupo: 'Ana', hash: 'misma-lista' }),
        subido('Lista de precios.pdf', 'pdf', { grupo: 'Beto', hash: 'misma-lista' }),
      ),
      terminarMaterial,
      dep,
    )
    assert.equal(escuchas, 1)
    assert.deepEqual(pasos(ia).filter((p) => p === 'describir_video' || p === 'transcribir_archivo').sort(), ['describir_video', 'transcribir_archivo'])
    const [deAna, deBeto, lista, otraLista] = estado.material.archivos
    assert.equal(deBeto.texto, deAna.texto)
    assert.equal(deBeto.duracion, deAna.duracion)
    assert.equal(otraLista.texto, lista.texto)

    // Y lo que ya se leyó en una pasada anterior no se vuelve a leer para su copia.
    const despues = conMaterial(subido('ya-leido.opus', 'audio', { hash: 'h', texto: 'hola', duracion: 4 }), subido('copia.opus', 'audio', { hash: 'h' }))
    const otra = await avanzar(despues, terminarMaterial, dependencias(iaFalsa(sinFaltantes()), {}))
    assert.deepEqual([otra.material.archivos[1].texto, otra.material.archivos[1].duracion], ['hola', 4])
  })
})

describe('lo que no se puede leer no traba el material', () => {
  const noAbre = async (): Promise<never> => {
    throw new ErrorMultimedia('Invalid data found when processing input', 'ilegible')
  }

  it('el adjunto de una conversación con chat queda con su nota y se sigue', async () => {
    const ia = iaFalsa({ transcribir_archivo: [{ texto: 'Foto del local' }], describir_video: [{ descripcion: 'Un auto.' }], ...sinFaltantes() })
    const dep = dependencias(ia)
    dep.transcribirAudio = async (archivo) => (archivo.tipo === 'audio' ? noAbre() : escucha('así queda'))
    const estado = await avanzar(conMaterial(...conversacionDeLaura()), terminarMaterial, dep)

    // Nadie puede volver a grabar el audio de un cliente: no tiene sentido frenar por eso.
    assert.equal(estado.etapa, 'entrevista')
    const audio = estado.material.archivos[1]
    assert.deepEqual([audio.texto, audio.problema], ['', textos.PROBLEMA_AUDIO])
    assert.ok(estado.avisos.some((a) => a.includes('00000043-AUDIO.opus') && a.includes('Invalid data')))
    assert.match(JSON.parse(materialQueVeClaude(ia))[0].text, /\[Audio «00000043-AUDIO\.opus»: no se pudo escuchar\]/)
  })

  it('un archivo suelto, o el chat mismo, sí vuelve a la lista: el dueño lo puede cambiar', async () => {
    const ia = iaFalsa(sinFaltantes())
    const dep = dependencias(ia)
    dep.transcribirAudio = noAbre
    let estado = await avanzar(conMaterial(subido('mensaje de bienvenida.opus', 'audio')), terminarMaterial, dep)
    assert.equal(estado.etapa, 'material')
    assert.equal(estado.material.avisoLectura, textos.AVISO_LECTURA)
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'material')
    assert.equal(pantalla.avisoLectura, textos.AVISO_LECTURA)
    assert.deepEqual([pantalla.archivos[0].estado, pantalla.archivos[0].problema], ['con_problema', textos.PROBLEMA_AUDIO])

    // La segunda vez sigue igual, sin volver a intentarlo y sin el aviso.
    let intentos = 0
    dep.transcribirAudio = async () => {
      intentos++
      return noAbre()
    }
    estado = await avanzar(estado, terminarMaterial, dep)
    assert.equal(estado.etapa, 'entrevista')
    assert.equal(estado.material.avisoLectura, null)
    assert.equal(intentos, 0)
  })

  it('un video solo queda con problema si no se pudo ver ni escuchar', async () => {
    const ia = iaFalsa({ describir_video: [{ descripcion: 'Un auto con fundas.' }], ...sinFaltantes() })
    const dep = dependencias(ia)
    dep.transcribirAudio = noAbre
    const grupo = 'Venta'
    const chat = subido('_chat.txt', 'texto', { grupo, texto: '[1/3/26, 10:15:02] Ana: <adjunto: a.mp4>\n[1/3/26, 10:15:09] Ana: <adjunto: b.mp4>' })
    const unEstado = conMaterial(chat, subido('a.mp4', 'video', { grupo }), subido('b.mp4', 'video', { grupo }))
    dep.fotogramasDeVideo = async (archivo) => (archivo.nombre === 'b.mp4' ? noAbre() : { cuadros: [Buffer.from('c')], segundos: 9, tieneVideo: true, tieneAudio: true })
    const estado = await avanzar(unEstado, terminarMaterial, dep)

    const [, a, b] = estado.material.archivos
    assert.deepEqual([a.texto, a.problema, a.duracion], ['Se ve: Un auto con fundas.\nSe escucha: no se pudo escuchar', undefined, 9])
    assert.deepEqual([b.texto, b.problema], ['', textos.PROBLEMA_VIDEO])
    assert.ok(estado.avisos.some((aviso) => aviso.includes('a.mp4') && aviso.includes('no se pudo escuchar')))
    assert.ok(estado.avisos.some((aviso) => aviso.includes('b.mp4') && aviso.includes('no se pudo ver')))
  })

  it('una falla cualquiera de ffmpeg o del transcriptor se trata igual: nunca como pasajera', async () => {
    const ia = iaFalsa(sinFaltantes())
    const dep = dependencias(ia)
    dep.transcribirAudio = async () => {
      throw new Error('spawn EACCES')
    }
    dep.imagenParaClaude = async () => {
      throw new ErrorMultimedia('No se encontró ffmpeg: revisá RUTA_FFMPEG.', 'sin_herramienta')
    }
    const estado = await avanzar(conMaterial(subido('a.opus', 'audio'), subido('foto.heic', 'imagen', { mime: 'image/heic' })), terminarMaterial, dep)
    // Se queda en la lista una vez, con las notas; no tira un error que obligue a «Reintentar» para siempre.
    assert.equal(estado.etapa, 'material')
    assert.deepEqual(estado.material.archivos.map((a) => [a.texto, a.problema]), [['', textos.PROBLEMA_AUDIO], ['', textos.PROBLEMA_ILEGIBLE]])
    assert.ok(estado.avisos.some((a) => a.includes('foto.heic') && a.includes('/api/salud')))
  })
})

describe('el plazo de lectura', () => {
  const nunca = () => new Promise<never>(() => {})

  it('un audio que no termina a tiempo vuelve a la lista como «todavía escuchando» y se retoma después', async () => {
    const ia = iaFalsa({ transcribir_archivo: [{ texto: 'Foto del local' }], describir_video: [{ descripcion: 'Un cubrevolante.' }], ...sinFaltantes() })
    const dep = { ...dependencias(ia), plazoMultimediaMs: 50 }
    dep.transcribirAudio = (archivo) => (archivo.tipo === 'audio' ? nunca() : Promise.resolve(escucha('así queda', { segundos: 68 })))
    let estado = await avanzar(conMaterial(...conversacionDeLaura()), terminarMaterial, dep)

    assert.equal(estado.etapa, 'material')
    assert.equal(estado.material.avisoLectura, textos.AVISO_EN_PROCESO)
    const [, audio, foto, video] = estado.material.archivos
    assert.deepEqual([audio.texto, audio.problema], [null, textos.PROBLEMA_EN_PROCESO])
    // Lo que sí se leyó queda guardado.
    assert.equal(foto.texto, 'Foto del local')
    assert.match(video.texto ?? '', /^Se ve: Un cubrevolante\./)
    // Para la pantalla no es un problema: se cuenta aparte.
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'material')
    assert.equal(pantalla.avisoLectura, textos.AVISO_EN_PROCESO)
    assert.deepEqual([pantalla.archivos[1].estado, pantalla.archivos[1].problema], ['en_proceso', null])
    assert.equal(mensajeEspera(estado, terminarMaterial), 'Escuchando los audios y mirando los videos. Puede tardar unos minutos.')

    // La transcripción terminó en segundo plano: al seguir se usa y no se vuelve a leer lo demás.
    dep.transcribirAudio = async () => escucha('Hola Laura, salen 80 mil.')
    estado = await avanzar(estado, terminarMaterial, dep)
    assert.equal(estado.etapa, 'entrevista')
    assert.equal(estado.material.avisoLectura, null)
    assert.deepEqual([estado.material.archivos[1].texto, estado.material.archivos[1].problema], ['Hola Laura, salen 80 mil.', undefined])
    assert.equal(pasos(ia).filter((p) => p === 'transcribir_archivo' || p === 'describir_video').length, 2)
  })

  it('un video ya descripto no se vuelve a mirar si lo que faltaba era el audio', async () => {
    const ia = iaFalsa({ describir_video: [{ descripcion: 'Un cubrevolante negro.' }], ...sinFaltantes() })
    const dep = { ...dependencias(ia), plazoMultimediaMs: 50 }
    dep.transcribirAudio = nunca
    let estado = await avanzar(conMaterial(subido('muestra.mp4', 'video')), terminarMaterial, dep)
    assert.deepEqual(
      [estado.material.archivos[0].texto, estado.material.archivos[0].descripcion, estado.material.archivos[0].problema],
      [null, 'Un cubrevolante negro.', textos.PROBLEMA_EN_PROCESO],
    )

    dep.transcribirAudio = async () => escucha('este es el cubrevolante')
    dep.fotogramasDeVideo = async () => {
      throw new Error('no tendría que volver a sacar los fotogramas')
    }
    estado = await avanzar(estado, terminarMaterial, dep)
    assert.equal(estado.material.archivos[0].texto, 'Se ve: Un cubrevolante negro.\nSe escucha: este es el cubrevolante')
    assert.equal(pasos(ia).filter((p) => p === 'describir_video').length, 1)
  })

  it('la descripción de un video se guarda por fuera del estado, por si el paso falla antes de guardarse', async () => {
    const guardadas = new Map<string, string>()
    const ia = iaFalsa({ describir_video: [{ descripcion: 'Un cubrevolante negro.' }], ...sinFaltantes() })
    const dep = dependencias(ia)
    dep.descripcionGuardada = async (archivo) => guardadas.get(archivo.hash ?? '') ?? null
    dep.guardarDescripcion = async (archivo, descripcion) => void guardadas.set(archivo.hash ?? '', descripcion)
    const video = subido('muestra.mp4', 'video')
    await avanzar(conMaterial(video), terminarMaterial, dep)
    assert.deepEqual([...guardadas], [[video.hash, 'Un cubrevolante negro.']])

    // Otro intento, sin respuesta preparada para describir_video: la saca de lo guardado.
    const otra = iaFalsa(sinFaltantes())
    const estado = await avanzar(conMaterial({ ...video }), terminarMaterial, { ...dep, ia: otra })
    assert.match(estado.material.archivos[0].texto ?? '', /^Se ve: Un cubrevolante negro\./)
  })

  it('con muchas fotos, al vencer el plazo no se toman más y quedan para la próxima', async () => {
    let llamadas = 0
    const ia: ClienteIa = {
      modelo: 'falso',
      async pedirJson<T>(pedido: PedidoJson): Promise<T> {
        if (pedido.paso !== 'transcribir_archivo') return (pedido.paso === 'revisar_material' ? { faltan: [] } : { propuestas: [] }) as T
        llamadas++
        await new Promise((listo) => setTimeout(listo, 40))
        return { texto: `captura ${llamadas}` } as T
      },
    }
    const dep = { ...dependencias(ia), plazoMultimediaMs: 60 }
    const fotos = Array.from({ length: 12 }, (_, i) => subido(`captura ${i}.png`, 'imagen'))
    let estado = await avanzar(conMaterial(...fotos), terminarMaterial, dep)

    assert.equal(estado.etapa, 'material')
    assert.equal(estado.material.avisoLectura, textos.AVISO_EN_PROCESO)
    const leidas = estado.material.archivos.filter((a) => a.texto !== null).length
    assert.ok(leidas >= 4 && leidas < 12, `se leyeron ${leidas}`)
    assert.equal(llamadas, leidas)
    // Una foto sin leer no dice «lo estamos escuchando»: queda como recién subida.
    const pantalla = pantallaActual(estado)
    assert.ok(pantalla.tipo === 'material')
    assert.deepEqual([...new Set(pantalla.archivos.map((a) => a.estado))].sort(), ['listo', 'sin_leer'])

    // Al seguir se leen las que faltan, sin repetir las que ya estaban.
    estado = await avanzar(estado, terminarMaterial, { ...dep, plazoMultimediaMs: 60_000 })
    assert.equal(estado.etapa, 'entrevista')
    assert.equal(llamadas, 12)
  })
})

describe('lo automático nunca se le propone al dueño como texto suyo', () => {
  it('descarta lo que salió de una transcripción, de una descripción o que arrastra un rótulo de la app', async () => {
    const ia = iaFalsa({
      transcribir_archivo: [{ texto: 'FUNDAS NORTE - calidad garantizada', descripcion: 'Asiento delantero con funda negra y costura roja.' }],
      describir_video: [{ descripcion: 'Una mano muestra un cubrevolante negro.' }],
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        {
          propuestas: [
            // Lo dijo en un audio: lo escribió Whisper, no el dueño.
            { id: '1.1', texto: 'Hola Laura, las de cuero ecológico salen 80 mil de lista.', fuente: 'Conversación «Venta cerrada - Laura»' },
            // Lo describió Claude mirando la foto.
            { id: '1.2', texto: 'Asiento delantero con funda negra y costura roja.', fuente: 'Conversación «Venta cerrada - Laura»' },
            // Escrito por el dueño, pero copiado con el rótulo que pone la app.
            { id: '1.2', texto: 'Así quedan con el vivo rojo [Foto «00000056-PHOTO.jpg»: FUNDAS NORTE - calidad garantizada', fuente: 'Conversación «Venta cerrada - Laura»' },
          ],
        },
      ],
    })
    const dep = dependencias(ia)
    dep.transcribirAudio = async (archivo) => escucha(archivo.tipo === 'audio' ? 'Hola Laura, las de cuero ecológico salen 80 mil de lista.' : 'así queda')
    const estado = await avanzar(conMaterial(...conversacionDeLaura()), terminarMaterial, dep)
    assert.equal(estado.etapa, 'entrevista')
    assert.deepEqual(estado.entrevista.propuestas, {})
  })

  it('lo que sí escribió, o lo que está escrito en una foto, se propone', async () => {
    const ia = iaFalsa({
      transcribir_archivo: [{ texto: 'FUNDAS NORTE - calidad garantizada', descripcion: 'Un cartel.' }],
      describir_video: [{ descripcion: 'Un cubrevolante.' }],
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [
        {
          propuestas: [
            { id: '1.1', texto: 'Así quedan con el vivo rojo', fuente: 'Conversación «Venta cerrada - Laura»' },
            { id: '1.2', texto: 'FUNDAS NORTE - calidad garantizada', fuente: 'Conversación «Venta cerrada - Laura»' },
          ],
        },
      ],
    })
    const estado = await avanzar(conMaterial(...conversacionDeLaura()), terminarMaterial, dependencias(ia))
    assert.deepEqual(Object.keys(estado.entrevista.propuestas), ['1.1', '1.2'])
    assert.equal(estado.entrevista.propuestas['1.1'].fuente, 'Conversación «Venta cerrada - Laura»')
  })

  it('una cita del brief que solo está en un audio no pasa por literal', async () => {
    const dicho = 'Trabajamos solo con cuero ecológico resistente al agua y al sol'
    const ia = iaFalsa({
      revisar_material: [{ faltan: [] }],
      proponer_respuestas: [{ propuestas: [] }, { propuestas: [] }],
      escribir_seccion_brief: [{ markdown: '## 1. Oferta' }, { markdown: `## 5. Preguntas frecuentes\nR: "${dicho}"` }, { markdown: `## 5. Preguntas frecuentes\nR: "${dicho}"` }],
      evaluar_respuesta: [aceptar],
      analizar_cierre: [cierre(0)],
      cerrar_brief: [briefFinal],
    })
    const dep = dependencias(ia)
    dep.transcribirAudio = async () => escucha(`${dicho}, para que dure años.`)
    let estado = await avanzar(conMaterial(subido('explicación.opus', 'audio')), terminarMaterial, dep)
    estado = await aplicar(estado, [{ tipo: 'no_se' }, { tipo: 'no_se' }, respuesta('Les digo que no hacemos tela')], dep)
    // Reintentó el brief y, como sigue citando el audio, lo dejó anotado para el reporte.
    assert.equal(ia.pedidos.filter((p) => p.paso === 'escribir_seccion_brief').length, 3)
    assert.ok(estado.avisos.some((a) => a.startsWith('Sección 5 del brief') && a.includes(dicho)))
  })
})

describe('el chat del principio con archivos', () => {
  it('con el .zip de una conversación arma el chat con sus adjuntos y no frena por lo que no llega', async () => {
    const ia = iaFalsa({ transcribir_archivo: [{ texto: '', descripcion: 'Asiento con funda negra.' }], clasificar: [clasificacionSimple] })
    const dep = { ...dependencias(ia), plazoMultimediaMs: 50 }
    dep.transcribirAudio = (archivo) => (archivo.tipo === 'video' ? new Promise<never>(() => {}) : Promise.resolve(escucha('Hola Laura, salen 80 mil.')))
    dep.fotogramasDeVideo = async () => ({ cuadros: [], segundos: 5, tieneVideo: false, tieneAudio: true })
    const estado = estadoInicial('Tapicería Norte')
    estado.etapa = 'pedido_chat'
    estado.material.archivos.push(...conversacionDeLaura('WhatsApp Chat - Laura').map((a) => ({ ...a, etapa: 'pedido_chat' as const })))
    assert.equal(mensajeEspera(estado, respuesta('')), 'Leyendo la conversación y escuchando los audios.')

    const siguiente = await avanzar(estado, respuesta('Esta es la última que cerré ⟪bien⟫'), dep)
    assert.equal(siguiente.etapa, 'confirmacion')
    const chat = siguiente.chat ?? ''
    assert.ok(chat.startsWith('Esta es la última que cerré «bien»\n\n## Conversación: WhatsApp Chat - Laura\n'))
    assert.match(chat, /\[Audio «00000043-AUDIO\.opus», 0:13, transcripción automática: ⟪Hola Laura, salen 80 mil\.⟫\]/)
    assert.match(chat, /\[Foto «00000056-PHOTO\.jpg»: ⟪Asiento con funda negra\.⟫\]/)
    // El video no llegó a tiempo: se sigue sin él, queda dicho y no queda esperando para siempre.
    assert.match(chat, /\[Audio «00000084-VIDEO\.mp4»: no se pudo escuchar\]/)
    const video = siguiente.material.archivos[3]
    assert.deepEqual([video.texto, video.problema], ['', textos.PROBLEMA_AUDIO])
    assert.ok(siguiente.avisos.some((a) => a.includes('00000084-VIDEO.mp4') && a.includes('plazo')))
    // En la versión literal del material no queda nada de lo que dijo el audio.
    assert.ok(!soloLiteral(chat).includes('salen 80 mil'))
  })
})

describe('cuestionarios empezados antes de las conversaciones', () => {
  it('un estado viejo (sin grupo, sin hash, con el .zip guardado como texto) sigue andando', async () => {
    const ia = iaFalsa({ transcribir_archivo: [{ texto: 'Cliente: hola' }], ...sinFaltantes() })
    const estado = estadoEnMaterial()
    // Así quedaban: sin `avisoLectura`, y cada archivo sin conversación ni hash.
    delete estado.material.avisoLectura
    estado.material.archivos.push(
      { id: 'zip', nombre: 'WhatsApp Chat - Laura.zip', mime: 'application/zip', tipo: 'texto', bytes: 900, texto: CHAT_DE_LAURA, etapa: 'material' },
      { id: 'captura', nombre: 'captura.png', mime: 'image/png', tipo: 'imagen', bytes: 10, texto: null, etapa: 'material' },
      { id: 'rota', nombre: 'rota.png', mime: 'image/png', tipo: 'imagen', bytes: 10, texto: '', etapa: 'material', problema: textos.PROBLEMA_ILEGIBLE },
    )
    // La pantalla de antes deducía el aviso de los archivos con problema: ahora lo hace el servidor.
    const antes = pantallaActual(estado)
    assert.ok(antes.tipo === 'material')
    assert.equal(antes.avisoLectura, textos.AVISO_LECTURA)
    assert.deepEqual(
      antes.archivos.map((a) => [a.grupo, a.esChat, a.estado, a.duracion, a.bytes]),
      [
        [null, true, 'listo', null, 900],
        [null, false, 'sin_leer', null, 10],
        [null, false, 'con_problema', null, 10],
      ],
    )

    const siguiente = await avanzar(estado, terminarMaterial, dependencias(ia))
    assert.equal(siguiente.etapa, 'entrevista')
    assert.equal(siguiente.material.avisoLectura, null)
    const material = JSON.parse(materialQueVeClaude(ia))[0].text as string
    // Sin conversaciones, el material sale con la forma de siempre; lo que el chat nombra y no está, queda como estaba.
    assert.match(material, /### WhatsApp Chat - Laura\.zip\n\[16\/9\/26, 10:05:44\] Laura: Hola!/)
    assert.match(material, /<adjunto: 00000043-AUDIO\.opus>/)
    assert.match(material, /### captura\.png\nCliente: hola/)
    assert.doesNotMatch(material, /## Conversación|## Archivos sueltos/)
    // A Claude se le dice que un chat suelto también cuenta como conversación.
    assert.match(JSON.stringify(ia.pedidos.find((p) => p.paso === 'revisar_material')!.mensaje), /cada chat suelto/)
  })

  it('el material que no entra entero queda avisado una sola vez', async () => {
    const ia = iaFalsa({ revisar_material: [{ faltan: ['la conversación de alguien que no compró'] }, { faltan: [] }], proponer_respuestas: [{ propuestas: [] }] })
    const estado = conMaterial(subido('manual.docx', 'texto', { texto: 'Paso a paso\n'.repeat(40_000) }))
    let siguiente = await avanzar(estado, terminarMaterial, dependencias(ia))
    siguiente = await avanzar(siguiente, terminarMaterial, dependencias(ia))
    assert.equal(siguiente.etapa, 'entrevista')
    assert.equal(siguiente.avisos.filter((a) => a.startsWith('El material no entró entero')).length, 1)
    assert.match(siguiente.avisos.find((a) => a.startsWith('El material no entró entero')) ?? '', /«manual\.docx»/)
  })
})
