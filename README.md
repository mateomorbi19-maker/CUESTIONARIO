# Cuestionario del proceso comercial

Formulario con IA que documenta cómo vende un negocio antes de construirle su agente.

- Reglas del proyecto: [`AGENTS.md`](AGENTS.md)
- Plan y decisiones: [`docs/PLAN.md`](docs/PLAN.md)
- Contrato de la API: [`docs/API.md`](docs/API.md)
- Deploy: [`docs/EASYPANEL.md`](docs/EASYPANEL.md)

## En local

```bash
npm install
cp .env.example .env
npm run dev
```

Sin `DATABASE_URL` usa una base embebida en `data/pglite`, así que no hace falta Docker. El
estado del sistema está en http://localhost:3000/api/salud.

### Audios y videos

Los audios y los videos que sube un cliente se escuchan en la misma máquina, con Whisper, sin
ninguna clave. Para que eso ande en local hacen falta tres cosas:

1. **El transcriptor.** `npm install` ya lo instala: es el paquete aparte de `transcriptor/`.
2. **El modelo.** Se baja una sola vez, unos 250 MB, a `data/modelos`:

   ```bash
   npm run modelo
   ```

   Si la descarga se corta, corré el comando de nuevo: sigue desde donde quedó.
3. **ffmpeg 8.1 o posterior.** Si no está en el PATH, poné su ruta en `.env`:

   ```
   RUTA_FFMPEG=C:\ffmpeg\bin\ffmpeg.exe
   ```

`/api/salud` dice en `multimedia` si está todo. Sin alguna de las tres cosas la app anda igual:
cada audio queda con la nota de que no se pudo escuchar.

## Cómo sube el cliente sus conversaciones

Cada conversación se sube por separado y queda separada hasta el brief: los audios, las fotos y
los videos de un chat nunca se mezclan con los de otro. En la pantalla del material hay cuatro
caminos:

- **Subir el .zip de WhatsApp.** Es lo que sale de «Exportar chat» con archivos. Se elige tal
  cual, sin abrirlo: adentro viene el chat con todos sus adjuntos, y cada .zip es una conversación.
- **Elegir carpeta** (solo en la compu). Una carpeta con el chat y sus adjuntos es una
  conversación. Si es una carpeta con varias adentro, sale una conversación por cada una.
- **Armar una conversación con archivos sueltos.** Se le pone un nombre y se agregan sus archivos.
  Sirve en el celular, donde no se pueden elegir carpetas.
- **Otros archivos.** La lista de precios, el catálogo, el guion: lo que no es de una conversación.

Se acepta cualquier archivo, de hasta 200 MB. Lo que no se puede leer queda guardado con una nota
al lado, y el cliente sigue igual. Los archivos grandes se suben en partes: con mala señal la
subida tarda más, pero no se corta, y mientras tanto conviene no bloquear el celular ni cambiar de
app.

## Pruebas

```bash
npm run prueba
```

No llaman a Claude ni transcriben nada: el motor se prueba con una IA, un ffmpeg y un Whisper
falsos. Las pruebas que sí usan ffmpeg de verdad se saltean si no está instalado.

La imagen de Docker se prueba en GitHub en cada push a `main`
([`.github/workflows/imagen.yml`](.github/workflows/imagen.yml)): se construye, se levanta y
transcribe un audio adentro.

## Simulador

Con `ANTHROPIC_API_KEY` en `.env`, dueños de negocio inventados completan el cuestionario contra
Claude real:

```bash
npm run simular -- clinica
npm run simular -- clinica --completo
```

El primero llega hasta el cuestionario generado; el segundo, hasta los entregables. Deja todo lo
generado, la transcripción y el costo aproximado en `pruebas/salidas/`.

## Uso

El link para los clientes es `https://tu-dominio/?c=<CODIGO_ACCESO>`. Cómo deployar y qué
variables cargar: [`docs/EASYPANEL.md`](docs/EASYPANEL.md).
