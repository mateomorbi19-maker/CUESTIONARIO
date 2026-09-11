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

Opcionales: `TOPE_CUESTIONARIOS_POR_DIA` (20 por defecto), `TOPE_LLAMADAS_POR_CUESTIONARIO`
(600 por defecto) y `MODELO_IA` (`claude-sonnet-5` por defecto). `DIR_DATOS`, `PORT` y `NODE_ENV`
ya vienen fijadas en el Dockerfile.

Si la contraseña de Postgres tiene `#`, `?`, `/` o `@`, la URL se corta ahí y la base responde
como si la contraseña estuviera mal. Cambiala por una sin esos caracteres.

## 4. Verificar

Abrí `https://tu-dominio/api/salud`. Tiene que devolver:

- `"ok": true`, con `base.motor` en `"postgres"` y `skills.ok` en `true`;
- `"listoParaClientes": true`. Si es `false`, la lista `faltan` dice qué variable completar.

## 5. El link para el cliente

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
inventado: así confirmás que el mail con los entregables llega.

## Contraseña de aplicación de Gmail

Necesita la verificación en dos pasos activada en la cuenta. Se crea en
https://myaccount.google.com/apppasswords: son 16 letras y van en `SMTP_CLAVE`, sin espacios.

## Límite de gasto

La página y el repositorio son públicos. Además de los topes de la app, poné un límite de gasto
mensual en la consola de Anthropic, en la sección de límites de la organización. Un cuestionario
completo cuesta unos pocos dólares.
