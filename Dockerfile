# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
# node:24-alpine
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS builder
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
# node:24-alpine
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runner
LABEL org.opencontainers.image.title="AI Limits Tracker" \
      org.opencontainers.image.description="Self-hosted web panel tracking AI subscription usage limits" \
      org.opencontainers.image.source="https://github.com/piyushkumarjiit/AI-Limits-Tracker" \
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
