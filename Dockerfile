FROM node:22 AS builder
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

# Install all dependencies (node:22 has python3/make/g++ for native modules)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# Reinstall production-only deps (smaller node_modules, native modules rebuilt)
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# --- Production image (slim, no build tools) ---
FROM node:22-slim AS production
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/

# Data directory for SQLite (mount a volume at /data)
RUN mkdir -p /data
ENV POLYFARM_DB_PATH=/data/polyfarm.db

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run", "--budget", "30", "--spread", "3", "--max-markets", "3", "--hedge-fills", "--placement-mode", "adaptive"]
