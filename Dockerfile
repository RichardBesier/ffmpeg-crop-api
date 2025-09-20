FROM node:20-bullseye

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    xz-utils \
    fonts-dejavu \
    fonts-noto-color-emoji \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Download and install newer static FFmpeg build
RUN wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    && tar -xf ffmpeg-release-amd64-static.tar.xz \
    && mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ \
    && mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ \
    && rm -rf ffmpeg-* \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# Update font cache for emoji support
RUN fc-cache -fv

WORKDIR /app

# install deps (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev

# copy the rest
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]