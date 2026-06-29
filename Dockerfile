# syntax=docker/dockerfile:1

# Debian (glibc) base rather than alpine: better-sqlite3 ships glibc prebuilds,
# and ffmpeg installs cleanly from apt.

# ---- deps: full install (incl dev) so `next build` has its toolchain ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# node-gyp toolchain in case better-sqlite3 has no prebuild for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod-deps: production-only node_modules (native modules compiled for runtime) ----
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- runner ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
# ffmpeg is required by lib/audio.ts for audio extraction.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# `serverComponentsExternalPackages` (better-sqlite3, googleapis, openai,
# node-cron) are resolved from node_modules at runtime, so prod deps must ship.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder   --chown=node:node /app/.next        ./.next
COPY --chown=node:node next.config.mjs package.json ./

# Data dir for the SQLite DB (/app/data/app.db) and work files (/app/data/work).
# A PVC is mounted here in Kubernetes; this keeps local `docker run` working too.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 8080
CMD ["npm", "run", "start"]
