FROM node:20-bullseye

# Add backports repository for newer FFmpeg
RUN echo "deb http://deb.debian.org/debian bullseye-backports main" >> /etc/apt/sources.list

# Install newer FFmpeg from backports with all features
RUN apt-get update && apt-get install -y \
    fonts-dejavu \
    fonts-noto-color-emoji \
    fontconfig \
    && apt-get install -y -t bullseye-backports ffmpeg \
    && rm -rf /var/lib/apt/lists/*

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