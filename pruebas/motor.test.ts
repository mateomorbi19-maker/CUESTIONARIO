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
import {
  avanzar,
  ErrorEntrada,
  estadoInicial,
  INTENTOS_EXAMEN,
  MAXIMO_PREGUNTAS_FINALES,
  pantallaActual,
  progreso,
  type Dependencias,
} from '../lib/motor/motor'
import * as textos from '../lib/motor/textos'
import type { Entrada, EstadoCuestionario } from '../lib/motor/tipos'

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

function dependencias(ia: ClienteIa, archivos: Record<string, Buffer> = {}): Dependencias {
  return {
    ia,
    skill: async (nombre) => `TEXTO DE LA SKILL ${nombre}`,
    leerArchivo: async (archivo) => archivos[archivo.id] ?? Buffer.from('contenido'),
    plantillaClaude: async () => '# [Tu negocio]\n\n## Qué es este proyecto\n\n[PENDIENTE — lo completa /entrevista]',
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
const seisRespuestas = Array.from({ length: 6 }, (_, i) => respuesta(`respuesta ${i + 1}`))

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
    assert.equal(pantalla.texto, textos.PREGUNTAS_TRIAGE[0])
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

  it('con las seis respuestas y material suficiente pasa a confirmar la clasificación', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple] })
    const estado = await aplicar(estadoInicial('Clínica'), seisRespuestas, dependencias(ia))
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
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [noAlcanza], clasificar: [clasificacionSimple] })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Cerrajería'), seisRespuestas, dep)
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
      evaluar_triage: Array(6).fill(seguir),
      evaluar_alcance: [noAlcanza],
      transcribir_archivo: [{ texto: 'Cliente: se me trabó la puerta' }],
      clasificar: [clasificacionSimple],
    })
    const dep = dependencias(ia, { captura: Buffer.from([0xff, 0xd8, 0xff]) })
    let estado = await aplicar(estadoInicial('Cerrajería'), seisRespuestas, dep)
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
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [hibrido, clasificacionSimple] })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Gimnasio'), seisRespuestas, dep)
    assert.deepEqual(pantallaActual(estado), { tipo: 'eleccion', texto: textos.ELECCION_HIBRIDO, opciones: hibrido.procesos })

    await assert.rejects(avanzar(estado, { tipo: 'eleccion', opcion: 'otra' }, dep), ErrorEntrada)
    estado = await avanzar(estado, { tipo: 'eleccion', opcion: 'agendar la clase de prueba' }, dep)
    assert.equal(estado.etapa, 'confirmacion')
    assert.equal(estado.procesoElegido, 'agendar la clase de prueba')
  })

  it('una corrección se guarda y reclasifica', async () => {
    const ia = iaFalsa({
      evaluar_triage: Array(6).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple, { ...clasificacionSimple, arquetipo: 'A' }],
    })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Clínica'), seisRespuestas, dep)
    estado = await avanzar(estado, { tipo: 'corregir', texto: 'No, el chat termina cuando pagan la seña' }, dep)
    assert.deepEqual(estado.correcciones, ['No, el chat termina cuando pagan la seña'])
    assert.equal(estado.clasificacion?.arquetipo, 'A')
  })

  it('saca el rótulo "Acción terminal del chat bueno:" si el modelo lo copia en el valor', async () => {
    const conRotulo: SalidaClasificacion = { ...clasificacionSimple, accion_terminal: 'Acción terminal del chat bueno: le paso la dirección y quedamos en un horario' }
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [conRotulo] })
    const estado = await aplicar(estadoInicial('Cerrajería'), seisRespuestas, dependencias(ia))
    assert.equal(estado.clasificacion?.accionTerminal, 'le paso la dirección y quedamos en un horario')
  })
})

describe('generación del examen', () => {
  const hastaConfirmar = (ia: ClienteIa) => aplicar(estadoInicial('Clínica'), seisRespuestas, dependencias(ia))

  it('si la validación falla, reintenta con los errores y se queda con la versión válida', async () => {
    const invalido = examenValido()
    invalido.secciones[0].preguntas[0] = 'Contá cómo es tu día.'
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple], generar_examen: [invalido, examenValido()] })
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
      evaluar_triage: Array(6).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple],
      generar_examen: Array.from({ length: INTENTOS_EXAMEN }, () => invalido),
    })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))
    assert.equal(estado.etapa, 'material')
    assert.ok(estado.pendientesExamen.some((e) => e.startsWith('Falta en la sección 8')))
  })

  it('la nota del cuestionario general queda con el texto exacto de la skill', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple], generar_examen: [{ ...examenValido(), nota: 'Es general.' }] })
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
