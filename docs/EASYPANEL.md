# Deploy en Easypanel

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

| Variable | Valor | Desde |
|---|---|---|
| `DATABASE_URL` | URL interna del Postgres del paso 1 | Fase 0 |
| `ANTHROPIC_API_KEY` | Tu clave de la consola de Anthropic | Fase 1 |
| `CODIGO_ACCESO` | Un código largo inventado por vos | Fase 2 |
| `URL_PUBLICA` | `https://tu-dominio` | Fase 2 |
| `SMTP_HOST` | `smtp.gmail.com` | Fase 4 |
| `SMTP_PUERTO` | `465` | Fase 4 |
| `SMTP_USUARIO` | Tu dirección de Gmail | Fase 4 |
| `SMTP_CLAVE` | Contraseña de aplicación de Google (ver abajo) | Fase 4 |
| `SMTP_REMITENTE` | Tu dirección de Gmail | Fase 4 |
| `MAIL_AVISO` | Dónde querés recibir el aviso | Fase 4 |

`DIR_DATOS`, `PORT` y `NODE_ENV` ya vienen fijadas en el Dockerfile.

Si la contraseña de Postgres tiene `#`, `?`, `/` o `@`, la URL se corta ahí y la base
responde como si la contraseña estuviera mal. Cambiala por una sin esos caracteres.

## 4. Verificar

Abrí `https://tu-dominio/api/salud`. Tiene que devolver `"ok": true`, con `base.motor` en
`"postgres"` y `skills.ok` en `true`. Si no, el campo `detalle` dice qué arreglar. La lista
`variables` muestra cuáles faltan cargar, sin mostrar sus valores.

## Contraseña de aplicación de Gmail

Necesita la verificación en dos pasos activada en la cuenta. Se crea en
https://myaccount.google.com/apppasswords: son 16 letras y van en `SMTP_CLAVE`, sin espacios.

## Límite de gasto

La página y el repositorio son públicos. Además de los topes que trae la app, poné un límite de
gasto mensual en la consola de Anthropic, en la sección de límites de la organización.
