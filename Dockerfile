FROM node:20-bullseye

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
