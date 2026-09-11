import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as textos from '../lib/motor/textos'

/*
 * La app muestra estos textos sin pasar por la IA. Si una skill cambia su redacción y esto no
 * se actualiza, el cliente vería una versión vieja: esta prueba es la que avisa.
 */
const leer = (skill: string) => readFileSync(join(process.cwd(), 'skills', skill, 'SKILL.md'), 'utf8')

const deMiNegocio: [string, string][] = [
  ['REPREGUNTA_ACCION_TERMINAL', textos.REPREGUNTA_ACCION_TERMINAL],
  ['PEDIDO_CHAT', textos.PEDIDO_CHAT],
  ...textos.PREGUNTAS_RECONSTRUCCION.map((texto, i): [string, string] => [`PREGUNTAS_RECONSTRUCCION[${i}]`, texto]),
  ['NOTA_GENERICO', textos.NOTA_GENERICO],
  ['ELECCION_HIBRIDO', textos.ELECCION_HIBRIDO],
]

const deEntrevista: [string, string][] = [['FRASE_RESPONDE_COMO_AGENTE', textos.FRASE_RESPONDE_COMO_AGENTE]]

describe('los textos fijos siguen siendo los de las skills', () => {
  const miNegocio = leer('mi-negocio')
  for (const [nombre, texto] of deMiNegocio) {
    it(`mi-negocio: ${nombre}`, () => {
      assert.ok(miNegocio.includes(texto), `${nombre} ya no aparece tal cual en skills/mi-negocio/SKILL.md: actualizalo en lib/motor/textos.ts`)
    })
  }

  // Las preguntas del triage están reescritas para la web: no se comparan letra por letra, pero
  // cada una tiene que seguir apuntando a una pregunta que exista en la Fase 0 de la skill.
  it('mi-negocio: cada pregunta del triage reemplaza una distinta de la Fase 0, y la primera es la de la acción terminal', () => {
    const numeros = textos.PREGUNTAS_TRIAGE.map((p) => p.enLaSkill)
    assert.equal(numeros[0], 1, 'La primera tiene que ser la de la acción terminal: de ella dependen la repregunta de la skill y la Fase 0.5.')
    assert.equal(new Set(numeros).size, numeros.length, 'Dos preguntas del formulario apuntan a la misma pregunta de la skill.')
    assert.ok(!numeros.includes(2), 'La 2 de la skill (quién hace la última parte del chat bueno) se sacó del formulario a pedido de Mateo.')
    for (const numero of numeros) {
      // En la skill la 1 abre la Fase 0 sin número; las demás van como "**N.**".
      const inicio = numero === 1 ? 'Pensá en el último chat que salió bien' : `**${numero}.**`
      assert.ok(
        miNegocio.includes(inicio),
        `La pregunta ${numero} de la Fase 0 ya no está en skills/mi-negocio/SKILL.md: revisá PREGUNTAS_TRIAGE en lib/motor/textos.ts`,
      )
    }
  })

  it('la introducción del triage dice cuántas preguntas son', () => {
    const enLetras = ['cero', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho']
    assert.match(textos.INTRODUCCION_TRIAGE, new RegExp(`\\b${enLetras[textos.PREGUNTAS_TRIAGE.length]}\\b`))
  })

  const entrevista = leer('entrevista')
  for (const [nombre, texto] of deEntrevista) {
    it(`entrevista: ${nombre}`, () => {
      assert.ok(entrevista.includes(texto), `${nombre} ya no aparece tal cual en skills/entrevista/SKILL.md: actualizalo en lib/motor/textos.ts`)
    })
  }

  it('la plantilla de CLAUDE.md tiene los [PENDIENTE] que completa la entrevista', () => {
    const plantilla = readFileSync(join(process.cwd(), 'skills', 'starter-kit', 'CLAUDE.md'), 'utf8')
    assert.ok(plantilla.includes('[PENDIENTE'), 'skills/starter-kit/CLAUDE.md ya no tiene [PENDIENTE]: revisá la copia del starter kit')
  })
})
