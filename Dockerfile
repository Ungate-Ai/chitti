FROM node:23.3.0

RUN npm install -g pnpm@9.4.0

WORKDIR /app

COPY pnpm-workspace.yaml package.json .npmrc tsconfig.json pnpm-lock.yaml /app/

RUN pnpm install --frozen-lockfile

COPY packages /app/packages
COPY agent /app/agent
COPY characters /app/characters
COPY scripts /app/scripts

COPY .env /app/.env
COPY .env /app/agent/.env

RUN pnpm exec playwright install
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0

WORKDIR /app

RUN pnpm run build

EXPOSE 3000 4000

HEALTHCHECK CMD curl --fail http://localhost:3000 || exit 1

CMD ["pnpm", "run", "start"]
