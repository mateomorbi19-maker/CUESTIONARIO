# Imagen de producción para Easypanel.
# Multi-etapa: las dependencias de compilación no llegan a la imagen final.
#
# La base es Debian y no Alpine: onnxruntime-node, que corre Whisper, solo trae binarios para
# glibc. La verificación de esta imagen es .github/workflows/imagen.yml: la construye, la levanta
# y transcribe un audio adentro.

FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# El postinstall de la raíz instala el transcriptor solo si existe transcriptor/package.json.
# Acá no está copiado, así que no hace nada: el transcriptor tiene su propia etapa.
RUN npm ci


# El transcriptor es un paquete aparte que la app lanza como proceso hijo. Va en su propia etapa
# para que la capa no cambie con cada cambio de la app.
FROM node:24-trixie-slim AS transcriptor
WORKDIR /transcriptor
COPY transcriptor/package.json transcriptor/package-lock.json ./
# --ignore-scripts: el postinstall de onnxruntime-node baja 236 MB de CUDA que acá no se usan.
# La variable dice lo mismo por si algún día se saca esa opción.
# Los binarios de CPU ya vienen dentro del paquete, para todos los sistemas: se dejan solo los
# de Linux de esta arquitectura. onnxruntime-web (140 MB) es para el navegador: la versión de
# Node de transformers no lo carga.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find node_modules/onnxruntime-node/bin/napi-v6/linux -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} + \
 && rm -rf node_modules/onnxruntime-web
COPY transcriptor/transcribir.mjs ./


# Los modelos de Whisper van dentro de la imagen. Esta capa queda en caché mientras no cambie el
# script; si Hugging Face no responde, falla el build, que se ve, y no el cuestionario de un
# cliente. El script controla la huella de cada archivo.
FROM node:24-trixie-slim AS modelo
COPY scripts/bajar-modelo.mjs /bajar-modelo.mjs
RUN node /bajar-modelo.mjs /modelos todos


# ffmpeg estático. Tiene que ser 8.1 o posterior: recién ahí arma las fotos HEIC del iPhone. El
# de apt de Debian es más viejo y además arrastra 450 MB de bibliotecas. Va fijado por digest
# (el índice de amd64 y arm64) para que el mismo tag no pueda traer otro binario.
FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg


FROM node:24-trixie-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# DATABASE_URL no se usa durante el build: las rutas que tocan la base son dinámicas.
RUN npm run build


FROM node:24-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DIR_DATOS=/app/data
ENV RUTA_FFMPEG=/usr/local/bin/ffmpeg
ENV RUTA_TRANSCRIPTOR=/app/transcriptor/transcribir.mjs
ENV DIR_MODELOS=/app/modelos

# Mismo uid y gid que tenía la imagen Alpine: el volumen de producción ya tiene archivos de ese
# dueño, y con otro número la app no los podría leer ni borrar.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin nextjs

# Punto de montaje del volumen persistente: los archivos que suben los clientes. Estas carpetas
# solo aparecen en un volumen nuevo; en uno que ya existe las crea la app al escribir.
RUN mkdir -p /app/data/archivos /app/data/subidas && chown -R nextjs:nodejs /app/data

# Lo pesado y que casi nunca cambia va primero: así las imágenes de dos deploys seguidos
# comparten estas capas (unos 700 MB) en vez de repetirlas en el disco del servidor.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
# Fuera de /app/data: el volumen se monta ahí y taparía los modelos.
COPY --from=modelo /modelos ./modelos
COPY --from=transcriptor /transcriptor ./transcriptor

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Las skills se leen del disco en cada cuestionario. El empaquetado de Next no las detecta
# solo, así que van copiadas a mano al lado de server.js.
COPY --from=builder --chown=nextjs:nodejs /app/skills ./skills

VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
