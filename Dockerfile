# Imagen de producción para Easypanel.
# Multi-etapa: las dependencias de compilación no llegan a la imagen final.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# DATABASE_URL no se usa durante el build: las rutas que tocan la base son dinámicas.
RUN npm run build


FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DIR_DATOS=/app/data

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Las skills se leen del disco en cada cuestionario. El empaquetado de Next no las detecta
# solo, así que van copiadas a mano al lado de server.js.
COPY --from=builder --chown=nextjs:nodejs /app/skills ./skills

# Punto de montaje del volumen persistente: los archivos que suben los clientes.
RUN mkdir -p /app/data/archivos && chown -R nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
