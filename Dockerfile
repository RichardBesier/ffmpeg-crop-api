FROM node:20-bullseye

# ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev

# copy the rest
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
