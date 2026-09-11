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
  ['INTRODUCCION_TRIAGE', textos.INTRODUCCION_TRIAGE],
  ...textos.PREGUNTAS_TRIAGE.map((texto, i): [string, string] => [`PREGUNTAS_TRIAGE[${i}]`, texto]),
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
