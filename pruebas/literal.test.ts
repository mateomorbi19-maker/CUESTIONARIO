import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { citasDelMarkdown, citasQueNoAparecen, normalizarLiteral } from '../lib/motor/literal'

describe('citas del brief', () => {
  const markdown = `## 5. Preguntas frecuentes

P: ¿Hacen fundas en tela?
R: "Trabajamos solo con cuero ecológico resistente al agua y al sol"

P: ¿Cuánto tardan?
R: NO APLICA: el plazo lo confirma el taller

- **R:** [PENDIENTE: la respuesta cuando piden descuento]

El dueño suele decir “Te entiendo, nosotros no competimos por precio” cuando dudan.
Frase corta: "Hola"`

  it('encuentra lo que va después de R: y lo que está entre comillas, sin marcadores ni frases cortas', () => {
    assert.deepEqual(citasDelMarkdown(markdown), [
      'Trabajamos solo con cuero ecológico resistente al agua y al sol',
      'Te entiendo, nosotros no competimos por precio',
    ])
  })

  it('no marca nada si las citas están tal cual, aunque cambien espacios y comillas', () => {
    const fuente = `Trabajamos solo con cuero   ecológico resistente al agua y al sol, para que dure años.
Te entiendo, nosotros no competimos por precio porque garantizamos...`
    assert.deepEqual(citasQueNoAparecen(markdown, fuente), [])
  })

  it('marca la cita que la IA emprolijó', () => {
    const fuente = 'Trabajamos con cuero ecológico resistente al agua. Te entiendo, nosotros no competimos por precio'
    assert.deepEqual(citasQueNoAparecen(markdown, fuente), [
      'Trabajamos solo con cuero ecológico resistente al agua y al sol',
    ])
  })

  it('normaliza sin cambiar el contenido', () => {
    assert.equal(normalizarLiteral('  “Hola”\n\n  ¿cómo  va?  '), '"Hola" ¿cómo va?')
  })
})
