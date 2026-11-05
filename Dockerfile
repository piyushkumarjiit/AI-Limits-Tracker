# ---------- Stage 1: build ----------
# node:24-alpine
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --ignore-scripts --legacy-peer-deps

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY server ./server
COPY web ./web

RUN npm run build:web && npm run build:server && node --check server/dist/server.mjs

# ---------- Stage 2: runtime ----------
# node:24-alpine
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runner
LABEL org.opencontainers.image.title="FQD - Fleet Quota Display" \
      org.opencontainers.image.description="Unified observability deck for AI subscription fleets, proxy pools, and API keys" \
      org.opencontainers.image.source="https://github.com/piyushkumarjiit/FQD" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:24-alpine"
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
