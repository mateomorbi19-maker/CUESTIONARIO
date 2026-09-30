# API

Contrato entre las pantallas y el servidor. Los tipos están en `lib/estado-publico.ts` y
`lib/motor/tipos.ts`, y los límites en `lib/limites.ts`; si algo de acá no coincide con esos
archivos, valen los archivos.

Todas las respuestas son JSON.

## Errores

```ts
{ error: string, motivo?: MotivoError, recibidos?: number }
```

`error` dice qué pasó y qué hacer, y es lo que se le muestra a la persona. `motivo` es para que
la pantalla decida sin leer el texto: los textos cambian, los motivos no.

| Estado | `motivo` | Qué hace la pantalla |
|---|---|---|
| 404 | `link` | El token no existe. Es el **único** caso en que da el link por inválido |
| 409 | `version` | Otra pestaña avanzó: recarga el estado y reintenta sola |
| 409 | `procesando` | Se está procesando una respuesta: muestra el mensaje |
| 409 | `etapa` | Este paso no admite archivos: recarga el estado |
| 409 | `faltan_bytes` | Subida por partes: trae `recibidos` y se sigue desde ahí |
| 409 | `grupo_con_otro_chat` | Esa conversación ya tiene otro chat: renombra lo que está subiendo a «Nombre (2)» y reintenta |
| 409 | `ya_no_esta` | El archivo o la conversación ya no existe: recarga el estado, sin mostrar error |
| 410 | `subida_vencida` | La subida por partes venció o no existe: crea otra y sigue, sin mostrar error |

El 404 queda solo para el token. Una subida vencida o un archivo ya quitado nunca devuelven 404:
si lo hicieran, un doble toque en «Quitar» dejaría a la persona afuera de su cuestionario.

## Crear un cuestionario

`POST /api/cuestionarios`

```json
{ "codigo": "el de ?c= del link general", "negocio": "Tapicería Norte", "email": "dueno@negocio.com" }
```

| Estado | Cuerpo |
|---|---|
| 201 | `{ "token": "...", "url": "/c/<token>" }` |
| 200 | `{ "retomado": true, "email": "..." }`: ese mail ya tenía uno sin terminar y se le mandó el link para seguirlo |
| 400 | Faltan datos o el mail no es válido |
| 403 | El código no es el del link |
| 429 | Se llegó al tope de cuestionarios nuevos del día, o ya se le mandó el link para seguir tres veces en la última hora |
| 503 | No se pudo mandar el mail con el link para seguir |

Si el correo está configurado, se le manda al cliente su link personal. Si además ese mail ya
tiene un cuestionario sin terminar, no se abre otro: se crea un link nuevo para el mismo
cuestionario y se le manda por mail. Los links anteriores siguen andando. Sin correo
configurado, siempre se abre uno nuevo.

## Leer el estado

`GET /api/cuestionarios/:token` → 200 `EstadoPublico` · 404 si el token no existe.

`EstadoPublico` trae `negocio` y `email`: el inicio muestra de qué negocio es el cuestionario
empezado, y «Seguir más tarde» dice a qué mail le llegó el link.

## Mandar una entrada

`POST /api/cuestionarios/:token/entrada`

```json
{ "entrada": { "tipo": "respuesta", "texto": "..." }, "version": 7 }
```

| Estado | Cuerpo |
|---|---|
| 202 | `EstadoPublico` con `procesando: true` |
| 400 | La entrada no corresponde a la pantalla o está vacía |
| 409 | Ya se está procesando otra entrada (`procesando`), o `version` no coincide (`version`) |

La entrada se procesa en segundo plano: algunas llamadas a Claude tardan más de un minuto.
Mientras `procesando` sea `true`, la pantalla pide `GET` cada 2 segundos. Si termina con
`error`, se reintenta mandando `entradaPendiente` con la `version` nueva.

## Subir archivos

Solo en las pantallas `pedido_chat` y `material`, y no mientras se procesa.

### Qué se acepta

Todo. Una subida solo falla si el archivo está vacío, pesa más de 200 MB o no entra en lo que
queda del cuestionario. Lo demás se guarda siempre, y lo que no se puede leer queda con una nota
al lado (`problema`) en vez de frenar a la persona.

| Tipo | Qué entra | Cómo se lee |
|---|---|---|
| `imagen` | JPG, PNG, WEBP, GIF, y también HEIC, AVIF, BMP y TIFF | Claude, al seguir. Las que Claude no acepta tal cual (HEIC, más de ~7,5 MB o de 8000 px) se convierten antes a JPG con ffmpeg |
| `pdf` | PDF de hasta 22 MB | Claude, al seguir |
| `texto` | .txt, .csv, .md, Word (.docx), Excel (.xlsx) y el chat exportado de WhatsApp | En el momento, sin IA |
| `audio` | Notas de voz y audios (opus, ogg, m4a, mp3, wav, aac, flac, amr) | Whisper, en el servidor. Hasta 15 minutos por archivo |
| `video` | mp4, mov, webm, 3gp, avi, mkv | El audio, con Whisper. Además, Claude describe unos fotogramas parejos |
| `otro` | Cualquier otra cosa | No se lee: queda guardado con su nota |

El tipo sale de los primeros bytes del archivo, no de su nombre. A ffmpeg solo le llega lo que se
reconoció por su contenido, y siempre con el formato forzado y sin permiso para abrir nada que no
sea ese archivo: un texto renombrado a .mp4 queda como `otro`.

### Conversaciones

Cada archivo lleva su conversación: `grupo`, un texto, o `null` si es un archivo suelto. El grupo
sale de donde vino el archivo:

- **Una carpeta** (elegida o arrastrada): la pantalla manda cada archivo con el grupo que da
  `gruposDeRutas` de `lib/grupos.ts`. El grupo es la carpeta más alta, por debajo de la raíz
  común, que tiene adentro exactamente un chat de WhatsApp. Así «Audios y videos» queda dentro de
  su conversación, y elegir la carpeta madre da una conversación por subcarpeta. Un archivo suelto
  en la madre queda sin grupo.
- **Un .zip**: se abre en el servidor. Cada archivo de adentro queda como un archivo más, con el
  nombre del .zip como conversación (o con los de sus carpetas, si adentro hay varias
  conversaciones). El .zip en sí no se guarda. Solo se abre lo que termina en .zip y no es un
  documento empaquetado (.docx, .xlsx, .pptx, .odt, .epub, .pages…). Un .zip dentro de otro se
  abre un nivel, como conversación propia. Lo que no se pudo sacar (cifrado o dañado) vuelve en
  `subida.omitidos`.
- **Una conversación armada a mano** o «Agregar» en una que ya existe: la pantalla manda el nombre
  con `grupoElegido`.
- **Un chat suelto**: recibe su propio grupo, con su nombre sin la extensión. Y un archivo suelto
  que ese chat nombra (`<adjunto: …>`) se muestra y se lee dentro de esa conversación.

Reglas para que dos conversaciones no se mezclen:

- Un archivo que ya está en **esa misma conversación** (mismo nombre y mismos bytes) no se guarda
  de nuevo: cuenta en `subida.repetidos`. El mismo archivo en dos conversaciones distintas se
  guarda en las dos, pero se lee o se escucha una sola vez.
- Si a una conversación que ya tiene chat le llega **otro chat distinto**: si viene en un .zip,
  el .zip entero va a «Nombre (2)»; si no, 409 con `grupo_con_otro_chat` y la pantalla renombra
  lo que está subiendo.
- Los nombres de conversación van siempre en el cuerpo del pedido y nunca en la URL: traen nombres
  y teléfonos de clientes, y las URL quedan en los logs.

### Por qué hay dos formas de subir

El proxy de Easypanel (Traefik) corta cualquier pedido cuyo cuerpo tarde más de 60 segundos en
llegar. Con mala señal, un .zip de 15 MB no entra en ese tiempo y la subida fallaba siempre. Por
eso todo lo que pasa de 256 KiB viaja en partes: cada parte es un pedido corto, se reintenta sola
y, si se corta, se sigue desde donde quedó.

La pantalla arranca con partes de 512 KiB. Si una tarda más de 20 segundos o se corta, la
siguiente va a la mitad (mínimo 128 KiB); si van rápido, crecen hasta 1 MiB, que es lo máximo que
acepta el servidor.

### Archivos chicos: un solo pedido

`POST /api/cuestionarios/:token/archivos` · `multipart/form-data`

| Campo | Qué es |
|---|---|
| `archivos` | Uno o varios archivos. Pensado para los de hasta 256 KiB |
| `grupo` | La conversación. Vacío o ausente: ninguna |
| `grupoElegido` | `1` si la persona eligió o escribió la conversación. Ausente si se dedujo de una carpeta |

| Estado | Cuerpo |
|---|---|
| 200 | `ResultadoSubida` |
| 400 | Archivo vacío o de más de 200 MB, se pasa del total o de la cantidad del cuestionario, .zip dañado, el cuerpo llegó cortado, o el pedido entero pasa de 25 MB |
| 409 | `etapa`, `procesando` o `grupo_con_otro_chat` |

Todo el pedido se guarda o no se guarda nada.

### Archivos grandes: por partes

**1. Crear la subida**

`POST /api/cuestionarios/:token/subidas`

```json
{ "nombre": "WhatsApp Chat - Ana.zip", "bytes": 15728640, "grupo": null, "grupoElegido": false }
```

| Estado | Cuerpo |
|---|---|
| 201 | `SubidaCreada`: `{ "id": "<uuid>", "recibidos": 0, "tamanoParte": 1048576 }` |
| 400 | Datos inválidos, `bytes` fuera de 1 a 200 MB, o se pasa del total del cuestionario |
| 409 | `etapa` o `procesando` |
| 429 | Ya hay 6 subidas abiertas |

Si ya hay una subida abierta de ese cuestionario con el mismo nombre, los mismos bytes y el mismo
grupo, devuelve esa, con sus `recibidos`: después de recargar la página, volver a elegir el mismo
archivo lo retoma solo.

Para un .zip, el servidor usa `grupo` solo si la persona lo eligió (`grupoElegido`) o si la
pantalla lo mandó porque su carpeta es una conversación. Si `grupo` es `null`, la conversación
toma el nombre del .zip.

**2. Mandar cada parte**

`PUT /api/cuestionarios/:token/subidas/:id?desde=<n>`

El cuerpo son los bytes crudos (`application/octet-stream`): de 1 a 1.048.576, con
`desde + largo` menor o igual a los `bytes` declarados.

| Estado | Cuerpo |
|---|---|
| 200 | `ParteRecibida`: `{ "recibidos": 2097152 }` |
| 400 | `desde` no es un entero de 0 en adelante, la parte está vacía, pasa de 1 MiB o se pasa del tamaño declarado |
| 409 | `faltan_bytes` con `recibidos`: `desde` está más adelante de lo que el servidor tiene. Hay que seguir desde `recibidos` |
| 410 | `subida_vencida` |

Es idempotente: volver a mandar la misma parte no rompe nada.

**3. Terminar**

`POST /api/cuestionarios/:token/subidas/:id/terminar`

| Estado | Cuerpo |
|---|---|
| 200 | `ResultadoSubida` |
| 409 | `faltan_bytes` con `recibidos`; `etapa` o `procesando` (se puede reintentar); `grupo_con_otro_chat` |
| 410 | `subida_vencida` |

Repetirlo después de un éxito devuelve el mismo resultado con el estado actual, y dos llamadas a
la vez devuelven lo mismo: si la respuesta se pierde, reintentar no duplica nada.

**Cancelar**

`DELETE /api/cuestionarios/:token/subidas/:id` → 200 `{}`. Borra lo recibido.

### `ResultadoSubida`

Es un `EstadoPublico` completo con el detalle de la subida al lado:

```ts
interface ResultadoSubida extends EstadoPublico {
  subida: {
    agregados: number                              // un .zip suma uno por cada archivo de adentro
    repetidos: number                              // ya estaban en esa conversación
    omitidos: { nombre: string; motivo: string }[] // lo que venía en un .zip y no se pudo sacar
    grupos: (string | null)[]                      // conversaciones donde quedó lo subido
  }
}
```

Los campos del estado van arriba de todo a propósito: una pestaña que quedó abierta durante un
deploy espera un `EstadoPublico` pelado y lo sigue entendiendo.

### Límites

| Qué | Cuánto |
|---|---|
| Por archivo, incluido un .zip entero | 200 MB |
| Por cuestionario, contando lo que sale de los .zip | 500 MB |
| Archivos por cuestionario, contados después de abrir los .zip | 400 |
| Archivos dentro de un .zip | 1000 |
| Parte de una subida | 1 MiB como máximo |
| Subidas abiertas a la vez | 6 |
| Una subida abandonada | Deja de contar para los límites a las 2 horas sin partes nuevas; se borra a las 24 horas |
| Nombre de una conversación | 120 caracteres |
| Nombre de un archivo | 200 caracteres |
| Audio que se transcribe | Los primeros 15 minutos de cada archivo |
| PDF que se lee | Hasta 22 MB |

## Conversaciones

`PATCH /api/cuestionarios/:token/conversaciones` · cambia el nombre

```json
{ "grupo": "WhatsApp Chat - Ana", "nombre": "Ana, venta cerrada" }
```

| Estado | Cuerpo |
|---|---|
| 200 | `EstadoPublico` |
| 400 | El nombre está vacío o es el de otra conversación de ese paso |
| 409 | `ya_no_esta`, `etapa` o `procesando` |

`DELETE /api/cuestionarios/:token/conversaciones` · la quita con todos sus archivos

```json
{ "grupo": "WhatsApp Chat - Ana" }
```

Con `"grupo": null` quita los archivos sueltos. Mismas respuestas que el `PATCH`, sin el 400.

Las dos rutas alcanzan también a las subidas por partes que estén abiertas para esa conversación:
cambiar el nombre las renombra y quitar las borra.

## Quitar un archivo

`DELETE /api/cuestionarios/:token/archivos/:id` → 200 `EstadoPublico` · 409 `ya_no_esta` si ya se
había quitado.

## Qué ve la pantalla de cada archivo

Las pantallas `pedido_chat` y `material` traen `archivos: ArchivoPublico[]`:

```ts
interface ArchivoPublico {
  id: string
  nombre: string
  tipo: 'imagen' | 'pdf' | 'texto' | 'audio' | 'video' | 'otro'
  estado: 'listo' | 'sin_leer' | 'en_proceso' | 'con_problema'
  problema: string | null   // solo con estado 'con_problema'
  grupo: string | null      // la conversación, ya resuelta; null: suelto
  esChat: boolean           // es el chat exportado de su conversación, no un adjunto
  duracion: number | null   // segundos, en audios y videos ya escuchados
  bytes: number
}
```

- `sin_leer`: falta leerlo, y se lee al tocar «Listo, seguir».
- `en_proceso`: un audio o un video que todavía se está escuchando.
- `con_problema`: no se pudo leer. `problema` dice qué pasó y qué puede hacer la persona.

Los audios y los videos se empiezan a escuchar apenas terminan de subir, en segundo plano y de a
uno en todo el servidor. Al tocar «Listo, seguir» se usa lo que ya está y se espera el resto, con
un plazo único de 7 minutos para todo lo que se lee (Claude y Whisper).

La pantalla `material` trae además `avisoLectura`, que dice por qué se volvió a la lista:

- **No alcanzó el tiempo.** Lo leído queda guardado, lo que falta sigue en `en_proceso` y el aviso
  dice que todavía se está escuchando. Mientras dure ese aviso, la pantalla consulta el estado
  cada 20 segundos y, cuando no queda ninguno en proceso, manda sola `terminar_material`.
- **No se pudo leer un archivo suelto o el chat mismo.** El aviso lo dice y la persona puede
  quitarlo, subir otra versión o seguir igual.

Si lo que no se pudo leer es un adjunto de una conversación que tiene chat (un audio, una foto),
no se vuelve a la lista: queda la nota en el archivo, el aviso en `cierre.md` y se sigue. La
persona no puede volver a grabar el audio de un cliente.

Lo que sale de una transcripción automática o de la descripción de un video o de una foto le
llega a Claude marcado entre ⟪ y ⟫: sirve como dato, pero nunca pasa por texto escrito por el
dueño.

## Salud

`GET /api/salud` → estado de la base, las skills, las variables y los audios y videos.

```json
"multimedia": { "ok": true, "ffmpeg": "ok", "transcriptor": "ok", "modelo": "ok" }
```

Cada campo dice `ok` o qué falta. Al arrancar, el servidor prueba el transcriptor de verdad, con
un segundo de silencio, y acá se ve el resultado. Si falta algo, se suma a `faltan`, pero ni `ok`
ni `listoParaClientes` dependen de esto: sin transcriptor la app sigue andando y cada audio queda
con su nota.
