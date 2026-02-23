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

# Data directory for SQLite
RUN mkdir -p /data
VOLUME /data
ENV POLYFARM_DB_PATH=/data/polyfarm.db

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run", "--budget", "10", "--spread", "5"]
