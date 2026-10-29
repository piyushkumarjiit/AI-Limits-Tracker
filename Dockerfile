# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --ignore-scripts --legacy-peer-deps

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY server ./server
COPY web ./web

RUN npm run build:web && npm run build:server

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=1455 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    WEB_DIR=/app/web/dist

# Only the compiled artifacts; the server bundle has zero runtime dependencies.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 1455
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1455)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server.mjs"]
