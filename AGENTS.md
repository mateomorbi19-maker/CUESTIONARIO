# Cuestionario del proceso comercial

App web donde el dueño de un negocio contesta cómo vende hoy. Por detrás, Claude conduce el
cuestionario con las skills `mi-negocio` y `entrevista` del starter kit. Al terminar, le llega
a Mateo un mail con `examen.md`, `brief-comercial.md` y `CLAUDE.md`, listos para construir el
agente de ese negocio.

El plan y las decisiones tomadas están en `docs/PLAN.md`. Leelo antes de proponer cambios de
alcance.

## Antes de terminar

```bash
npm run prueba && npm run tipos && npm run build
```

## Lo que no se hace

1. **No editar `skills/`.** Es copia exacta del starter kit. Lo que cambia por ser web va en
   `lib/motor/instrucciones.ts` (`CAPA_WEB`), nunca adentro de un `SKILL.md`.
2. **No subir datos reales al repo.** El repositorio es público. Nada de claves, chats,
   briefs, precios, nombres de clientes ni el mail de aviso. Lo real va en `.env` (local), en
   las variables de Easypanel o en `pruebas/privadas/`, que git ignora.
3. **No mostrarle el resultado al cliente.** El cliente ve preguntas y, al final, un
   agradecimiento. Brief, contradicciones, simulación y pendientes van solo al mail.
4. **No agregar pasos manuales.** Todo el circuito es automático: ningún paso puede depender
   de que alguien haga algo a mano.
5. **No llamar a Claude por fuera de `lib/claude.ts`.** Ahí están el esquema de respuesta, la
   caché, el detector de respuestas cortadas y el registro de costos.
6. **No usar Server Actions.** Toda mutación va por `fetch` a un route handler de `app/api/`.
7. **No crear una carpeta de migraciones.** El esquema es el string `SCHEMA` de `lib/db.ts`,
   aplicado de forma idempotente. Los cambios se agregan ahí con `IF NOT EXISTS`.
8. **No agregar una dependencia sin justificarla** en la tabla de abajo. Antes, fijate si Node
   o el navegador ya lo traen.

## Lo que sí

- **Español en todo**: identificadores, comentarios, nombres de archivo, columnas
  (snake_case), clases CSS, copy. Voseo. Acentos en textos, nunca en identificadores.
- **Sin punto y coma, comillas simples, indentación de 2.**
- Todo acceso a la base pasa por `db()` de `lib/db.ts`, nunca por `pg` ni PGlite directo.
- Todo route handler exporta `runtime` y `dynamic`, y termina su `catch` en `errorApi`.
- Los mensajes de error dicen **qué hay que arreglar**, no «algo salió mal».
- Los comentarios explican **por qué**, no qué hace la línea de abajo.

## Motor

| Archivo | Qué hace |
|---|---|
| `lib/motor/motor.ts` | `avanzar(estado, entrada, dependencias)`: calcula el estado siguiente. `pantallaActual(estado)`: qué mostrar |
| `lib/motor/tipos.ts` | Etapas, estado guardado, pantallas y entradas |
| `lib/motor/textos.ts` | Textos que la skill manda decir tal cual. `pruebas/contrato.test.ts` los compara letra por letra con la skill |
| `lib/motor/instrucciones.ts` | `CAPA_WEB` y el pedido a Claude de cada paso, con su esquema JSON |
| `lib/examen.ts` | Arma, lee, pasa a markdown y valida el cuestionario con las reglas fijas de la skill |
| `lib/claude.ts` | Única salida hacia Claude |
| `lib/cuestionarios.ts` | Guardar y recuperar cuestionarios; registro de llamadas |

- El motor no toca la base ni la red salvo por `Dependencias`: las pruebas usan una IA falsa.
- `avanzar` trabaja sobre una copia del estado: si una llamada falla, lo guardado queda intacto.
- Si la skill cambia su redacción, falla la prueba de contrato: se actualiza `textos.ts`.
- `npm run simular` corre el motor contra Claude real con los negocios de
  `pruebas/personas.json`. Empezá siempre por una sola persona.

## Base de datos

Con `DATABASE_URL` se usa Postgres. Sin ella, y fuera de producción, se usa PGlite en
`data/pglite`: el mismo Postgres, corriendo dentro de Node, para desarrollar sin Docker. En
producción sin `DATABASE_URL` la app no arranca la base a propósito.

## Dependencias

| Paquete | Por qué |
|---|---|
| `next`, `react`, `react-dom` | La app |
| `pg` | Postgres en producción |
| `@electric-sql/pglite` | Base local sin instalar Docker, con el mismo SQL que producción |
| `@anthropic-ai/sdk` | Llamadas a Claude: tipos, reintentos y errores tipados |
| `tsx` (desarrollo) | Correr las pruebas y el simulador en TypeScript sin compilar |
