FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci

COPY server.js ./
COPY src ./src

ENV PORT=3004

EXPOSE 3004

CMD ["node", "server.js"]
