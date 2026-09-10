# Cuestionario del proceso comercial

App web donde el dueño de un negocio contesta cómo vende hoy. Por detrás, Claude conduce el
cuestionario con las skills `mi-negocio` y `entrevista` del starter kit. Al terminar, le llega
a Mateo un mail con `examen.md`, `brief-comercial.md` y `CLAUDE.md`, listos para construir el
agente de ese negocio.

El plan y las decisiones tomadas están en `docs/PLAN.md`. Leelo antes de proponer cambios de
alcance.

## Antes de terminar

```bash
npm run tipos && npm run build
```

## Lo que no se hace

1. **No editar `skills/`.** Es copia exacta del starter kit. Lo que cambia por ser web va en
   una capa aparte, nunca adentro de un `SKILL.md`.
2. **No subir datos reales al repo.** El repositorio es público. Nada de claves, chats,
   briefs, precios, nombres de clientes ni el mail de aviso. Lo real va en `.env` (local), en
   las variables de Easypanel o en `pruebas/privadas/`, que git ignora.
3. **No mostrarle el resultado al cliente.** El cliente ve preguntas y, al final, un
   agradecimiento. Brief, contradicciones, simulación y pendientes van solo al mail.
4. **No agregar pasos manuales.** Todo el circuito es automático: ningún paso puede depender
   de que alguien haga algo a mano.
5. **No usar Server Actions.** Toda mutación va por `fetch` a un route handler de `app/api/`.
6. **No crear una carpeta de migraciones.** El esquema es el string `SCHEMA` de `lib/db.ts`,
   aplicado de forma idempotente. Los cambios se agregan ahí con `IF NOT EXISTS`.
7. **No agregar una dependencia sin justificarla** en la tabla de abajo. Antes, fijate si Node
   o el navegador ya lo traen.

## Lo que sí

- **Español en todo**: identificadores, comentarios, nombres de archivo, columnas
  (snake_case), clases CSS, copy. Voseo. Acentos en textos, nunca en identificadores.
- **Sin punto y coma, comillas simples, indentación de 2.**
- Todo acceso a la base pasa por `db()` de `lib/db.ts`, nunca por `pg` ni PGlite directo.
- Todo route handler exporta `runtime` y `dynamic`, y termina su `catch` en `errorApi`.
- Los mensajes de error dicen **qué hay que arreglar**, no «algo salió mal».
- Los comentarios explican **por qué**, no qué hace la línea de abajo.

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
