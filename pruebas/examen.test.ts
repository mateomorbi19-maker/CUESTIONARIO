import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { armarExamen, examenAMarkdown, leerExamenMarkdown, validarExamen, type SalidaExamen } from '../lib/examen'

// npm corre los scripts parado en la raíz del proyecto.
const CARPETA = join(process.cwd(), 'pruebas', 'examenes')
const salidasHarness = readdirSync(CARPETA).filter((f) => f.endsWith('.md'))

describe('leerExamenMarkdown con las salidas reales del harness', () => {
  it('están las diez salidas', () => {
    assert.equal(salidasHarness.length, 10)
  })

  for (const archivo of salidasHarness) {
    const md = readFileSync(join(CARPETA, archivo), 'utf8')

    it(`${archivo}: lee encabezado, material y las nueve secciones sin perder preguntas`, () => {
      const { examen, problemas } = leerExamenMarkdown(md)
      assert.deepEqual(problemas, [])
      assert.ok(examen)
      assert.match(examen.arquetipo, /^[A-E]$/)
      assert.ok(examen.accionTerminal.length > 0)
      assert.ok(examen.material.length > 0)
      assert.deepEqual(
        examen.secciones.map((s) => s.numero),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      )
      // Desde la sección 1: algunas salidas numeran el material de la sección 0 (0.1., 0.2.).
      const lineasDePregunta = (md.match(/^\s*[1-9]\.\d+\.\s+/gm) ?? []).length
      assert.equal(examen.secciones.flatMap((s) => s.preguntas).length, lineasDePregunta)
    })

    it(`${archivo}: queda igual después de pasarlo a markdown y volver a leerlo`, () => {
      const { examen } = leerExamenMarkdown(md)
      assert.ok(examen)
      const otraVez = leerExamenMarkdown(examenAMarkdown(examen))
      assert.deepEqual(otraVez.problemas, [])
      assert.deepEqual(otraVez.examen, examen)
    })
  }
})

/** Un examen que cumple todas las reglas: 9 secciones de 4 preguntas. */
function salidaValida(): SalidaExamen {
  const secciones = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((numero) => ({
    numero,
    preguntas: [1, 2, 3, 4].map((i) =>
      [5, 6, 9].includes(numero)
        ? `Pegá cómo respondés en el caso ${numero}.${i}.`
        : `¿Qué dato número ${numero}.${i} anotás antes de confirmar? Nombralo.`,
    ),
  }))
  secciones[7].preguntas[2] = '¿Qué parte de atender un chat vas a seguir haciendo vos aunque el agente esté andando? Nombrala.'
  secciones[7].preguntas[3] = '¿Hay algo que no querés que se mencione nunca por chat? Escribilo.'
  return {
    negocio: 'Negocio de prueba',
    arquetipo: 'B',
    accion_terminal: 'el turno reservado',
    nota: '',
    material: ['Un chat que terminó en turno', 'Uno que preguntó y no agendó', 'Uno que canceló'],
    secciones,
  }
}

function validar(cambiar: (s: SalidaExamen) => void) {
  const salida = salidaValida()
  cambiar(salida)
  return validarExamen(armarExamen(salida))
}

describe('validarExamen', () => {
  it('un examen que cumple las reglas no tiene errores ni avisos', () => {
    const r = validar(() => {})
    assert.deepEqual(r.errores, [])
    assert.deepEqual(r.avisos, [])
    assert.equal(r.cantidadPreguntas, 36)
  })

  it('marca las preguntas que abren con un verbo de narración', () => {
    const r = validar((s) => {
      s.secciones[0].preguntas[0] = 'Contá cómo es un día normal.'
      s.secciones[1].preguntas[0] = 'Describí a tu cliente ideal.'
      s.secciones[2].preguntas[0] = '¿Cómo manejás los reclamos?'
    })
    assert.equal(r.errores.filter((e) => e.includes('verbo que pide narración')).length, 3)
  })

  it('no confunde "Contaste" con "Contá"', () => {
    const r = validar((s) => {
      s.secciones[0].preguntas[0] = 'Contaste que atendés de mañana: ¿a qué hora abrís?'
    })
    assert.deepEqual(r.errores, [])
  })

  it('marca "herramienta", "función" y "prompt", pero no "funcionamiento"', () => {
    const conProhibidas = validar((s) => {
      s.secciones[6].preguntas[0] = '¿Qué herramienta usás para cobrar?'
      s.material.push('El prompt que usás hoy')
    })
    assert.equal(conProhibidas.errores.length, 1)
    assert.match(conProhibidas.errores[0], /herramienta/)
    assert.match(conProhibidas.errores[0], /prompt/)

    const sinProhibidas = validar((s) => {
      s.secciones[6].preguntas[0] = '¿Cuál es el horario de funcionamiento del local?'
    })
    assert.deepEqual(sinProhibidas.errores, [])
  })

  it('exige las dos preguntas fijas de la sección 8', () => {
    const r = validar((s) => {
      s.secciones[7].preguntas[2] = '¿A quién derivás los reclamos? Nombralo.'
      s.secciones[7].preguntas[3] = '¿Qué no se promete nunca? Listalo.'
    })
    assert.equal(r.errores.filter((e) => e.startsWith('Falta en la sección 8')).length, 2)
  })

  it('respeta el rango de 30 a 45 preguntas', () => {
    const muchas = validar((s) => {
      s.secciones[0].preguntas.push(...Array.from({ length: 10 }, (_, i) => `¿Qué dato extra ${i} anotás?`))
    })
    assert.ok(muchas.errores.some((e) => e.includes('46 preguntas')))

    const pocas = validar((s) => {
      for (const seccion of s.secciones) if (seccion.numero !== 8) seccion.preguntas = seccion.preguntas.slice(0, 3)
    })
    assert.ok(pocas.errores.some((e) => e.includes('28 preguntas')))
  })

  it('exige las nueve secciones', () => {
    const r = validar((s) => {
      s.secciones = s.secciones.filter((seccion) => seccion.numero !== 4)
    })
    assert.ok(r.errores.some((e) => e.startsWith('Falta la sección 4')))
  })

  it('avisa si una sección de texto literal no pide texto pegado', () => {
    const r = validar((s) => {
      s.secciones[4].preguntas[0] = '¿Cuántas preguntas te hacen por día?'
    })
    assert.deepEqual(r.errores, [])
    assert.equal(r.avisos.length, 1)
    assert.match(r.avisos[0], /5\.1/)
  })
})

describe('armarExamen', () => {
  it('numera por código y saca la numeración que repite el modelo', () => {
    const salida = salidaValida()
    salida.secciones[2].preguntas[1] = '3.2. ¿En qué momento mandás el precio?'
    const examen = armarExamen(salida)
    const pregunta = examen.secciones[2].preguntas[1]
    assert.equal(pregunta.id, '3.2')
    assert.equal(pregunta.texto, '¿En qué momento mandás el precio?')
    assert.equal(examen.secciones[2].titulo, 'Cómo es el recorrido hoy')
  })
})

describe('reglas nuevas contra las salidas viejas del harness', () => {
  // Las salidas son anteriores a la regla de la sección 8: tienen que aparecer como error.
  // Si un día dejan de aparecer, o se regeneraron o la validación se rompió.
  it('detecta que ninguna salida vieja tiene las dos preguntas fijas de la sección 8', () => {
    for (const archivo of salidasHarness) {
      const { examen } = leerExamenMarkdown(readFileSync(join(CARPETA, archivo), 'utf8'))
      assert.ok(examen)
      const { errores } = validarExamen(examen)
      assert.ok(
        errores.some((e) => e.startsWith('Falta en la sección 8')),
        `${archivo} no marcó la sección 8`,
      )
    }
  })
})
