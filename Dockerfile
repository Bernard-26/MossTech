# syntax=docker/dockerfile:1

# ---- Stage 1: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: runtime image ----
FROM node:22-alpine AS runtime
# pg_dump powers the automatic backups and /api/admin/backup. It must be the same version as (or newer than)
# the postgres image in docker-compose.yml (17). If this package is unavailable the build still succeeds and the
# app simply skips backups (see DOCKER.md for host-side backups).
RUN apk add --no-cache postgresql17-client || echo "WARNING: pg_dump not installed - in-app backups disabled"

ENV PORT=3000 \
    HOST=0.0.0.0 \
    BACKUP_DIR=/app/backups
WORKDIR /app

# Dependencies first (better layer caching), then the app code. Runs as the unprivileged "node" user.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
RUN mkdir -p /app/backups && chown node:node /app/backups

USER node
EXPOSE 3000

# Ready = the web server answers AND PostgreSQL answers
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/readyz" >/dev/null || exit 1

# `node` (not `npm start`) so SIGTERM from `docker stop` reaches the app and it can shut down cleanly
CMD ["node", "server.js"]
