FROM node:20-bookworm-slim

# System tools required for full YouTube extraction and MP3 conversion.
# yt-dlp now uses an external JavaScript runtime + EJS challenge solver
# for reliable YouTube support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg ca-certificates curl unzip \
    && curl -fsSL https://deno.land/install.sh | sh \
    && /root/.deno/bin/deno --version \
    && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
    && yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.deno/bin:${PATH}"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm", "start"]
