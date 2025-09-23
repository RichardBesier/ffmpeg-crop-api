FROM node:20-bookworm-slim

# Install FFmpeg, fonts, canvas dependencies, and yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu \
    fonts-noto-color-emoji \
    fontconfig \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    python3-pip \
    && fc-cache -fv \
    && pip3 install --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev

# copy the rest
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]