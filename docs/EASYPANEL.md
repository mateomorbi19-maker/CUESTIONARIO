# Deploy en Easypanel

## 0. Qué servidor hace falta

Los audios y los videos que suben los clientes se escuchan en el mismo servidor, con Whisper. No
hace falta ninguna clave nueva, pero sí memoria y disco:

- **RAM: 4 GB recomendados, 2 GB como mínimo.** Mientras transcribe, el modelo `whisper-small`
  ocupa cerca de 1 GB, además de la app y de Postgres. Transcribe de a un audio por vez y
  devuelve la memoria al terminar. Con menos de 3 GB la app elige sola `whisper-base`, que ocupa
  unos 700 MB y se equivoca más con precios, cuotas y nombres de productos.
- **Disco.** La imagen crece unos 700 MB y queda cerca de 1 GB: trae los dos modelos (385 MB) y
  ffmpeg. El volumen guarda los archivos de los clientes: hasta 500 MB por cuestionario.
- **El primer build tarda más**, unos minutos: baja los modelos y ffmpeg. Los siguientes usan lo
  que quedó en caché.

## 1. Base de datos

1. En el proyecto de Easypanel: **+ Service → Postgres**. Nombre sugerido: `cuestionario-db`.
2. Copiá la **URL de conexión interna** del servicio: es la `DATABASE_URL`.

## 2. App

1. **+ Service → App**. Nombre sugerido: `cuestionario`.
2. **Source → GitHub**: `mateomorbi19-maker/CUESTIONARIO`, rama `main`. Es público, no hace
   falta token.
3. **Build → Dockerfile**, ruta `Dockerfile`.
4. **Mounts → Volume**: ruta de montaje `/app/data`. Ahí quedan los archivos que suben los
   clientes; sin volumen se pierden en cada deploy.
5. **Domains**: tu dominio, puerto **3000**.
6. **Environment**: las variables de abajo.
7. **Deploy**.

## 3. Variables

| Variable | Valor |
|---|---|
| `DATABASE_URL` | URL interna del Postgres del paso 1 |
| `ANTHROPIC_API_KEY` | Tu clave de la consola de Anthropic |
| `CODIGO_ACCESO` | Un código largo inventado por vos, sin espacios (por ejemplo, 20 letras y números al azar) |
| `URL_PUBLICA` | `https://tu-dominio`, sin barra al final |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PUERTO` | `465` |
| `SMTP_USUARIO` | Tu dirección de Gmail |
| `SMTP_CLAVE` | Contraseña de aplicación de Google (ver abajo) |
| `SMTP_REMITENTE` | Tu dirección de Gmail |
| `MAIL_AVISO` | Dónde querés recibir los entregables |

Opcionales:

| Variable | Si no está | Para qué |
|---|---|---|
| `TOPE_CUESTIONARIOS_POR_DIA` | 20 | Cuestionarios nuevos por día |
| `TOPE_LLAMADAS_POR_CUESTIONARIO` | 1000 | Llamadas a Claude por cuestionario. Cada foto que sube el cliente es una llamada |
| `MODELO_IA` | `claude-sonnet-5` | Modelo que conduce el cuestionario |
| `MODELO_TRANSCRIPCION` | Se elige solo según la RAM | `whisper-small` o `whisper-base`, para forzar uno |
| `HILOS_TRANSCRIPCION` | Hasta 2, dejando un núcleo libre | Hilos de CPU para transcribir |

`DIR_DATOS`, `PORT`, `NODE_ENV`, `RUTA_FFMPEG`, `RUTA_TRANSCRIPTOR` y `DIR_MODELOS` ya vienen
fijadas en el Dockerfile: no las cargues.

**Si `TOPE_LLAMADAS_POR_CUESTIONARIO` ya está cargada en Easypanel con 600** (era el valor de
antes), subila a 1000 o borrala. Con 600, un cliente que sube muchas fotos puede quedarse sin
llamadas antes de terminar.

Si la contraseña de Postgres tiene `#`, `?`, `/` o `@`, la URL se corta ahí y la base responde
como si la contraseña estuviera mal. Cambiala por una sin esos caracteres.

## 4. Antes de tocar Deploy

Cada push a `main` corre en GitHub la verificación **Imagen**
(`.github/workflows/imagen.yml`): construye la imagen igual que Easypanel, la levanta, mira
`/api/salud` y transcribe un audio adentro del contenedor. Se ve en la pestaña **Actions** del
repositorio y tarda unos minutos.

Tocá **Deploy** solo con ese check en verde. Si está en rojo, la imagen no arranca o no puede
escuchar audios, y el deploy dejaría así a los clientes que están a mitad del cuestionario.

## 5. Verificar

Abrí `https://tu-dominio/api/salud`. Tiene que devolver:

- `"ok": true`, con `base.motor` en `"postgres"` y `skills.ok` en `true`;
- `"listoParaClientes": true`. Si es `false`, la lista `faltan` dice qué variable completar;
- `"multimedia": { "ok": true, ... }`. Al arrancar, la app prueba el transcriptor de verdad, con
  un segundo de silencio: puede tardar unos segundos en ponerse en `true`.

Si `multimedia.ok` es `false`, los campos de al lado dicen qué falta:

| Campo | Si no dice `ok` |
|---|---|
| `ffmpeg` | No está el binario o no corre. La imagen se construyó mal: mirá el log del build |
| `transcriptor` | El proceso que corre Whisper no arrancó. Lo más común es falta de memoria: mirá el log de la app y probá con `MODELO_TRANSCRIPCION=whisper-base` |
| `modelo` | Faltan los archivos del modelo en la imagen: falló la descarga durante el build. Volvé a hacer Deploy |

Con `multimedia.ok` en `false` la app sigue andando: los clientes pueden completar el
cuestionario, pero cada audio y cada video queda con la nota «No pudimos escuchar este audio» y
su contenido no llega al brief. Por eso, si la prueba del arranque falla, además te llega un mail
a `MAIL_AVISO`.

## 6. El link para el cliente

```
https://tu-dominio/?c=<CODIGO_ACCESO>
```

Es el mismo link para todos. Cada cliente pone el nombre de su negocio y su mail, y la app le
arma su cuestionario y le manda por mail su link personal para seguir después. Cuando termina,
te llega a `MAIL_AVISO` un mail con `examen.md`, `brief-comercial.md`, `CLAUDE.md` y `cierre.md`.

Si un cliente perdió su link o quiere seguir desde otro dispositivo, que entre a este mismo link
general y ponga el mismo mail: no se le abre otro cuestionario, le llega por mail un link para
seguir donde quedó.

Antes de mandárselo a un cliente real, completalo vos una vez de punta a punta con un negocio
inventado, subiendo un .zip de WhatsApp con algún audio: así confirmás que el mail con los
entregables llega y que `cierre.md` trae la sección «Material» con la conversación.

## Contraseña de aplicación de Gmail

Necesita la verificación en dos pasos activada en la cuenta. Se crea en
https://myaccount.google.com/apppasswords: son 16 letras y van en `SMTP_CLAVE`, sin espacios.

## Límite de gasto

La página y el repositorio son públicos. Además de los topes de la app, poné un límite de gasto
mensual en la consola de Anthropic, en la sección de límites de la organización. Un cuestionario
completo cuesta unos pocos dólares. Transcribir audios no gasta nada de la API: corre en el
servidor.

## Disco: imágenes viejas

Cada deploy deja en el servidor la imagen anterior. Comparten las capas pesadas (modelos y
ffmpeg), pero igual se van sumando. Si el disco se llena, el build siguiente falla.

Cada tanto, borrá las que ya no se usan: en Easypanel, con la limpieza de Docker de la
configuración del servidor; o por SSH:

```bash
docker image prune -f
```

Eso borra solo las imágenes que quedaron sin nombre. La que está corriendo no se toca, y el
volumen con los archivos de los clientes tampoco.

## Subidas lentas

El proxy de Easypanel (Traefik) corta cualquier pedido que tarde más de 60 segundos en llegar.
No hace falta tocar esa configuración: la app sube los archivos grandes en partes chicas, cada
una muy por debajo de ese tiempo, y si una se corta sigue desde donde quedó.
