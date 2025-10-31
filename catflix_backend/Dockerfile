FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile --prod || pnpm install --prod

COPY server.js ./
COPY src ./src

ENV PORT=3004

EXPOSE 3004

CMD ["node", "server.js"]
