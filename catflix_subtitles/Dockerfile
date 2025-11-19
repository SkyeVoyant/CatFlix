FROM node:20-bookworm-slim

WORKDIR /app

# Install system dependencies: FFmpeg, Python, and build tools for Whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Whisper + Argos Translate via pip (--break-system-packages needed for Debian Bookworm)
RUN pip3 install --no-cache-dir --break-system-packages openai-whisper argostranslate

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json ./

# Install Node.js dependencies
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod

# Copy source code
COPY src ./src

# Create directories for subtitles and temp files
RUN mkdir -p /app/subtitles /app/temp/audio

ENV PORT=3006
ENV NODE_ENV=production

EXPOSE 3006

CMD ["node", "src/index.js"]

