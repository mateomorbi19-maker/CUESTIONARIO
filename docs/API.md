# API

Contrato entre las pantallas y el servidor. Los tipos están en `lib/estado-publico.ts` y
`lib/motor/tipos.ts`; si algo de acá no coincide con esos archivos, valen los archivos.

Todas las respuestas son JSON. Los errores son `{ "error": "qué pasó y qué hacer" }`.

## Crear un cuestionario

`POST /api/cuestionarios`

```json
{ "codigo": "el de ?c= del link general", "negocio": "Tapicería Norte", "email": "dueno@negocio.com" }
```

| Estado | Cuerpo |
|---|---|
| 201 | `{ "token": "...", "url": "/c/<token>" }` |
| 400 | Faltan datos o el mail no es válido |
| 403 | El código no es el del link |
| 429 | Se llegó al tope de cuestionarios nuevos del día |

Si el correo está configurado, se le manda al cliente su link personal. Si no, igual se crea.

## Leer el estado

`GET /api/cuestionarios/:token` → 200 `EstadoPublico` · 404 si el token no existe.

## Mandar una entrada

`POST /api/cuestionarios/:token/entrada`

```json
{ "entrada": { "tipo": "respuesta", "texto": "..." }, "version": 7 }
```

| Estado | Cuerpo |
|---|---|
| 202 | `EstadoPublico` con `procesando: true` |
| 400 | La entrada no corresponde a la pantalla o está vacía |
| 409 | Ya se está procesando otra entrada, o `version` no coincide (otra pestaña avanzó) |

La entrada se procesa en segundo plano: algunas llamadas a Claude tardan más de un minuto.
Mientras `procesando` sea `true`, la pantalla pide `GET` cada 2 segundos. Si termina con
`error`, se reintenta mandando `entradaPendiente` con la `version` nueva.

## Subir archivos

`POST /api/cuestionarios/:token/archivos` · `multipart/form-data`, campo `archivos` (uno o varios)

Solo en las pantallas `pedido_chat` y `material`, y no mientras se procesa.

| Estado | Cuerpo |
|---|---|
| 200 | `EstadoPublico` con los archivos nuevos en la pantalla |
| 400 | Tipo no permitido (audio, video, HEIC...) o archivo de más de 20 MB |
| 409 | La pantalla no acepta archivos o se está procesando |

Se aceptan imágenes (JPG, PNG, WEBP, GIF), PDF, Word (.docx), Excel (.xlsx), texto (.txt, .csv,
.md) y el .zip que exporta WhatsApp.

## Quitar un archivo

`DELETE /api/cuestionarios/:token/archivos/:id` → 200 `EstadoPublico`

## Salud

`GET /api/salud` → estado de la base, las skills y las variables.
