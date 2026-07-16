FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  xvfb \
  fluxbox \
  x11vnc \
  novnc \
  websockify \
  fonts-liberation \
  ca-certificates \
  libnspr4 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libatspi2.0-0 \
  libxcomposite1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

RUN mkdir -p /data/browser /app/media

ENV NODE_ENV=production \
  PORT=3000 \
  BROWSER_USER_DATA_DIR=/data/browser \
  BROWSER_PROFILE_DIR=Default \
  HEADLESS=1 \
  API_HEADLESS=1 \
  AUTO_CONTINUE=1 \
  ENABLE_VNC=0 \
  VNC_PORT=5900 \
  NOVNC_PORT=7900

EXPOSE 3000 5900 7900

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "api"]
