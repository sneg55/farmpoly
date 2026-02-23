FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

# --- Install dependencies ---
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build TypeScript ---
FROM deps AS build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# --- Production image ---
FROM base AS production
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist/ dist/

# Data directory for SQLite (mount a Railway volume at /data)
RUN mkdir -p /data
ENV POLYFARM_DB_PATH=/data/polyfarm.db

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run", "--budget", "30", "--spread", "5", "--max-markets", "1"]
