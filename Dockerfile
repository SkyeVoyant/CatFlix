# syntax=docker/dockerfile:1

# Build stage for frontend
FROM node:20-bookworm AS frontend-builder
WORKDIR /app/catflix_frontend

COPY catflix_frontend/package*.json ./
RUN npm ci

COPY catflix_frontend/ ./
RUN npm run build

# Runtime stage for backend + encoder
FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY catflix_backend/package*.json ./catflix_backend/
WORKDIR /app/catflix_backend
RUN npm ci

WORKDIR /app
COPY catflix_backend ./catflix_backend
COPY catflix_encoding ./catflix_encoding
COPY --from=frontend-builder /app/catflix_frontend/build ./catflix_backend/frontend/build

# share backend dependencies with encoder worker
RUN ln -s /app/catflix_backend/node_modules /app/catflix_encoding/node_modules

WORKDIR /app/catflix_backend

ENV PORT=3004

EXPOSE 3004

CMD ["node", "server.js"]
