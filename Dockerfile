FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ffmpeg \
  xvfb \
  fluxbox \
  x11vnc \
  novnc \
  websockify \
  fonts-liberation \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data/chrome /app/media

ENV NODE_ENV=production \
  PORT=3000 \
  CHROME_PATH=/usr/bin/chromium \
  CHROME_USER_DATA_DIR=/data/chrome \
  CHROME_PROFILE_DIR=Default \
  HEADLESS=1 \
  API_HEADLESS=1 \
  AUTO_CONTINUE=1 \
  ENABLE_VNC=0 \
  VNC_PORT=5900 \
  NOVNC_PORT=7900

EXPOSE 3000 5900 7900

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "api"]
