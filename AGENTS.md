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
| `lib/motor/motor.ts` | `avanzar(estado, entrada, dependencias)`: calcula el estado siguiente. `pantallaActual`, `progreso`, `mensajeEspera`, `validarEntrada` |
| `lib/motor/tipos.ts` | Etapas, estado guardado, pantallas y entradas: el contrato con las pantallas |
| `lib/motor/textos.ts` | Textos fijos. Los que vienen de una skill los compara `pruebas/contrato.test.ts` letra por letra. Las preguntas del triage están reescritas para la web y cada una dice qué pregunta de la skill reemplaza |
| `lib/motor/instrucciones.ts` | `CAPA_WEB` y el pedido a Claude de cada paso, con su esquema JSON |
| `lib/motor/literal.ts` | Controla que los textos que el dueño le escribe a un cliente lleguen al brief tal cual |
| `lib/motor/reporte.ts` | Arma `cierre.md`, lo que el cliente no ve |
| `lib/examen.ts` | Arma, lee, pasa a markdown y valida el cuestionario con las reglas fijas de la skill |
| `lib/claude.ts` | Única salida hacia Claude |
| `lib/cuestionarios.ts` | Guardar y recuperar cuestionarios; candado de procesamiento; registro de llamadas |
| `lib/proceso.ts` | Lo que hacen las rutas: crear, recibir entradas en segundo plano, subir archivos |
| `lib/avisos.ts` | Mail con el link al cliente y mail con los entregables, con reintentos |
| `lib/archivos.ts` | Lee lo que suben (imágenes, PDF, Word, Excel, chats de WhatsApp) sin IA cuando se puede |
| `lib/correo.ts` | Cliente SMTP sin dependencias, con adjuntos |

- El motor no toca la base ni la red salvo por `Dependencias`: las pruebas usan una IA falsa.
- `avanzar` trabaja sobre una copia del estado: si una llamada falla, lo guardado queda intacto.
- Las entradas se procesan en segundo plano (algunas llamadas tardan más de un minuto) y la
  pantalla consulta el estado. El candado es `procesando_desde` en la base.
- Si la skill cambia su redacción, falla la prueba de contrato: se actualiza `textos.ts`.
- `npm run simular -- <persona>` corre el motor contra Claude real hasta el cuestionario;
  con `--completo`, hasta los entregables. Empezá siempre por una sola persona.
- El contrato de la API está en `docs/API.md`.

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
