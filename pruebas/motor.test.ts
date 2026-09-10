import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ErrorIa, type ClienteIa, type PedidoJson } from '../lib/claude'
import type { SalidaAlcance, SalidaClasificacion, SalidaEvaluacion, SalidaExamenModelo } from '../lib/motor/instrucciones'
import { avanzar, ErrorEntrada, estadoInicial, INTENTOS_EXAMEN, pantallaActual, type Dependencias } from '../lib/motor/motor'
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
      return cola.shift() as T
    },
  }
}

function dependencias(ia: ClienteIa): Dependencias {
  return { ia, skill: async () => 'TEXTO DE LA SKILL' }
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

describe('triage', () => {
  it('arranca en la pregunta 1 con la introducción de la skill', () => {
    const pantalla = pantallaActual(estadoInicial('Clínica'))
    assert.equal(pantalla.tipo, 'pregunta')
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
    assert.equal(ia.pedidos.filter((p) => p.paso === 'evaluar_triage').length, 1)
  })

  it('con las seis respuestas y material suficiente pasa a confirmar la clasificación', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple] })
    const estado = await aplicar(estadoInicial('Clínica'), seisRespuestas, dependencias(ia))
    assert.equal(estado.etapa, 'confirmacion')
    assert.deepEqual(pantallaActual(estado), { tipo: 'confirmacion', texto: clasificacionSimple.mensaje })
  })

  it('manda la skill y la capa web como sistema, en ese orden', async () => {
    const ia = iaFalsa({ evaluar_triage: [seguir] })
    await avanzar(estadoInicial('Clínica'), respuesta('pagó'), dependencias(ia))
    assert.equal(ia.pedidos[0].sistema.length, 2)
    assert.equal(ia.pedidos[0].sistema[0], 'TEXTO DE LA SKILL')
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
    assert.equal(estado.reconstruccion.length, 3)
  })

  it('con un chat pegado clasifica y lo manda como material', async () => {
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [noAlcanza], clasificar: [clasificacionSimple] })
    const dep = dependencias(ia)
    let estado = await aplicar(estadoInicial('Cerrajería'), seisRespuestas, dep)
    estado = await avanzar(estado, respuesta('Cliente: hola, se me trabó la puerta'), dep)
    assert.equal(estado.etapa, 'confirmacion')
    assert.match(ia.pedidos.at(-1)!.mensaje, /<chat_real>\nCliente: hola, se me trabó la puerta\n<\/chat_real>/)
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
    assert.match(ia.pedidos.at(-1)!.mensaje, /<proceso_elegido>/)
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
    assert.equal(estado.etapa, 'confirmacion')
    assert.deepEqual(estado.correcciones, ['No, el chat termina cuando pagan la seña'])
    assert.equal(estado.clasificacion?.arquetipo, 'A')
  })

  it('saca el rótulo "Acción terminal del chat bueno:" si el modelo lo copia en el valor', async () => {
    const conRotulo: SalidaClasificacion = {
      ...clasificacionSimple,
      accion_terminal: 'Acción terminal del chat bueno: le paso la dirección y quedamos en un horario',
    }
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [conRotulo] })
    const estado = await aplicar(estadoInicial('Cerrajería'), seisRespuestas, dependencias(ia))
    assert.equal(estado.clasificacion?.accionTerminal, 'le paso la dirección y quedamos en un horario')
  })
})

describe('generación del examen', () => {
  async function hastaConfirmar(ia: ClienteIa) {
    return aplicar(estadoInicial('Clínica'), seisRespuestas, dependencias(ia))
  }

  it('si la validación falla, reintenta con los errores y se queda con la versión válida', async () => {
    const invalido = examenValido()
    invalido.secciones[0].preguntas[0] = 'Contá cómo es tu día.'
    const ia = iaFalsa({
      evaluar_triage: Array(6).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple],
      generar_examen: [invalido, examenValido()],
    })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))

    assert.equal(estado.etapa, 'material')
    assert.deepEqual(estado.pendientesExamen, [])
    const pedidosExamen = ia.pedidos.filter((p) => p.paso === 'generar_examen')
    assert.equal(pedidosExamen.length, 2)
    assert.match(pedidosExamen[1].mensaje, /verbo que pide narración/)
    assert.equal(estado.examen?.arquetipo, 'B')
    assert.equal(estado.examen?.accionTerminal, 'turno reservado')
  })

  it('después de los reintentos sigue igual y deja los errores pendientes', async () => {
    const invalido = examenValido()
    invalido.secciones[7].preguntas = ['¿A quién derivás? Nombralo.']
    const ia = iaFalsa({
      evaluar_triage: Array(6).fill(seguir),
      evaluar_alcance: [alcanza],
      clasificar: [clasificacionSimple],
      generar_examen: Array.from({ length: INTENTOS_EXAMEN }, () => structuredClone(invalido)),
    })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))
    assert.equal(estado.etapa, 'material')
    assert.ok(estado.pendientesExamen.some((e) => e.startsWith('Falta en la sección 8')))
    assert.equal(ia.pedidos.filter((p) => p.paso === 'generar_examen').length, INTENTOS_EXAMEN)
  })

  it('la nota del cuestionario general queda con el texto exacto de la skill', async () => {
    const conNota = { ...examenValido(), nota: 'Es general.' }
    const ia = iaFalsa({ evaluar_triage: Array(6).fill(seguir), evaluar_alcance: [alcanza], clasificar: [clasificacionSimple], generar_examen: [conNota] })
    const estado = await avanzar(await hastaConfirmar(ia), { tipo: 'confirmar' }, dependencias(ia))
    assert.equal(estado.examen?.nota, textos.NOTA_GENERICO)
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
  })
})
