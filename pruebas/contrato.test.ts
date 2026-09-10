import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as textos from '../lib/motor/textos'

/*
 * La app muestra estos textos sin pasar por la IA. Si la skill cambia su redacción y esto no
 * se actualiza, el cliente vería una versión vieja: esta prueba es la que avisa.
 */
const skill = readFileSync(join(process.cwd(), 'skills', 'mi-negocio', 'SKILL.md'), 'utf8')

const fijos: [string, string][] = [
  ['INTRODUCCION_TRIAGE', textos.INTRODUCCION_TRIAGE],
  ...textos.PREGUNTAS_TRIAGE.map((texto, i): [string, string] => [`PREGUNTAS_TRIAGE[${i}]`, texto]),
  ['REPREGUNTA_ACCION_TERMINAL', textos.REPREGUNTA_ACCION_TERMINAL],
  ['PEDIDO_CHAT', textos.PEDIDO_CHAT],
  ...textos.PREGUNTAS_RECONSTRUCCION.map((texto, i): [string, string] => [`PREGUNTAS_RECONSTRUCCION[${i}]`, texto]),
  ['NOTA_GENERICO', textos.NOTA_GENERICO],
  ['ELECCION_HIBRIDO', textos.ELECCION_HIBRIDO],
]

describe('los textos fijos del motor siguen siendo los de skills/mi-negocio/SKILL.md', () => {
  for (const [nombre, texto] of fijos) {
    it(nombre, () => {
      assert.ok(skill.includes(texto), `${nombre} ya no aparece tal cual en la skill: actualizalo en lib/motor/textos.ts`)
    })
  }
})
