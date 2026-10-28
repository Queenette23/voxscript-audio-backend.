# Official bgutil PO-token provider (same 2.0.0 release for provider + plugin).
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0-node AS bgutil

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg ca-certificates curl \
    && python3 -m pip install --no-cache-dir --break-system-packages -U \
        "yt-dlp[default]" "bgutil-ytdlp-pot-provider==2.0.0" \
    && yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*

# Copy the official PO-token provider server and its dependencies.
COPY --from=bgutil /app /opt/bgutil

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"
EXPOSE 10000

CMD ["./start.sh"]
