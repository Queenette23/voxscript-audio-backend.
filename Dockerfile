FROM node:20-slim

RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir -U yt-dlp --break-system-packages

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY start.sh ./

RUN chmod +x start.sh

ENV NODE_ENV=production
EXPOSE 10000

CMD ["./start.sh"]
