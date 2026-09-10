# Plan

Acordado el 2026-09-10. Si algo de esto cambia, se actualiza este archivo en el mismo cambio.

## Qué es

Un formulario web que completa el dueño de un negocio antes de que se le construya su agente
de IA. Por detrás, Claude corre las dos skills de la clase 1 del starter kit:

1. **`mi-negocio`**: seis preguntas de triage. Clasifica el negocio (arquetipo A a E) y genera
   un cuestionario a medida de 9 secciones y entre 30 y 45 preguntas.
2. **`entrevista`**: conduce ese cuestionario, repregunta lo vago y escribe `brief-comercial.md`.

Al terminar, a Mateo le llega un mail con `examen.md`, `brief-comercial.md`, `CLAUDE.md`
completo y `cierre.md`. Con eso sigue en Claude Code con `/etapas` y `/prompt`.

## Decisiones

| # | Decisión |
|---|---|
| 1 | Solo clase 1: `mi-negocio` + `entrevista`. Nada de etapas, prompt ni herramientas. |
| 2 | El cliente no ve el resultado: responde preguntas y al final ve un agradecimiento. |
| 3 | Deploy propio en Easypanel con Docker, desde este repositorio, que es público. |
| 4 | No se aceptan audios. |
| 5 | Todo automático: ningún paso depende de que alguien haga algo a mano. |
| 6 | El aviso de cuestionario terminado llega solo por mail. |
| 7 | Sin panel de administración en la primera versión: todo llega en el mail. |

## Circuito

1. Un único link general, con código (`CODIGO_ACCESO`), para todos los clientes.
2. El cliente pone el nombre del negocio y su mail. Se le crea su cuestionario y se le manda
   por mail su link personal para retomar. Desde el mismo dispositivo retoma solo.
3. Triage → confirmación de cómo termina un chat bueno → generación del cuestionario →
   material (chats y documentos) → entrevista por secciones → cierre interno → preguntas
   finales → agradecimiento.
4. Mail a Mateo con los archivos.

Si el negocio tiene dos procesos distintos (por ejemplo vende y además agenda), el formulario
le pregunta al cliente cuál atender primero. La skill lo pide así y no requiere intervención.

## Motor

- La app conduce los pasos. Cada llamada a Claude devuelve JSON validado contra un esquema.
- Por cada respuesta, la IA decide: aceptar, repreguntar (una sola vez), pendiente o no aplica.
- Al cerrar cada sección se escribe esa parte del brief: guardar y retomar sale solo.
- Las reglas fijas las verifica código: 9 secciones, 30 a 45 preguntas, verbos prohibidos,
  las dos preguntas de la sección 8, y que no aparezcan "herramienta", "función" ni "prompt".
- Las skills se cargan tal cual. Encima va una capa con las reglas del canal web.
- El cierre de `/entrevista` (estilo, contradicciones, cobertura, simulación) corre por
  dentro. Lo que falta vuelve al cliente como preguntas normales, con tope. Los reportes van
  al mail.
- Cada llamada a Claude queda registrada con modelo, tokens y `stop_reason`.

## Negocios con procesos ramificados

El primer cliente real tiene varios productos, precio distinto según forma de pago y zona, y
un guion donde las frases exactas importan. Para que el cuestionario sirva ahí:

1. **Respuesta por variante.** Si la respuesta depende del producto, de la forma de pago o de
   la zona, el formulario pide una respuesta por variante. No suma preguntas.
2. **Texto literal intocable.** Lo que el cliente pega como texto va al brief igual. Código
   verifica que cada frase textual del brief aparezca letra por letra en las respuestas.
3. **Confirmar sobre lo escrito.** Si sube su guion o sus preguntas frecuentes, la pregunta
   que ya tiene respuesta ahí se muestra como "En tu documento dice… ¿Sigue así?". El mail
   trae la sección "Qué cambió respecto de lo que tenían escrito".
4. **Chats recientes.** El material pide chats de las últimas semanas. Capturas y texto
   pegado tienen que funcionar tan bien como un chat exportado.
5. **Plan contra práctica.** Lo que suena a plan y no aparece en los chats se marca en el
   reporte.

## Fases

| Fase | Qué | Lista cuando |
|---|---|---|
| 0 · Base | Proyecto, skills, Dockerfile, `/api/salud`, deploy | `/api/salud` responde ok en el dominio |
| 1 · Motor | Pasos, IA, reglas y base; `pruebas/personas.json` hace de cliente | Tres personas completan todo; se comparan modelos en calidad y costo |
| 2 · Formulario | Pantallas, guardado automático, link personal, celular | Se completa entero desde el teléfono |
| 3 · Adjuntos | Imágenes, PDF, Excel, Word, chats en texto o captura | Anda con material real de prueba |
| 4 · Cierre | Mail con adjuntos, topes de gasto, código de acceso | El mail llega con los cuatro archivos |
| 5 · Piloto | Primer cliente real | Completó el cuestionario y el paquete sirve para arrancar su agente |

Antes de mandarle el link a un cliente real se corre una simulación con su material, fuera del
repositorio (`pruebas/privadas/`), y se verifica que el brief cubra todo lo que su documento ya
tenía.
