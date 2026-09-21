# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

ARG NOVNC_VERSION=1.7.0

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  xvfb \
  fluxbox \
  x11vnc \
  websockify \
  fonts-liberation \
  ca-certificates \
  curl \
  libnspr4 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libatspi2.0-0 \
  libxcomposite1 \
  && mkdir -p /usr/share/novnc \
  && curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/share/novnc \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

ENV NODE_ENV=production \
  PORT=6767 \
  BROWSER_USER_DATA_DIR=/data/browser \
  BROWSER_PROFILE_DIR=Default \
  CLOAKBROWSER_CACHE_DIR=/data/cloakbrowser \
  HEADLESS=1 \
  API_HEADLESS=1 \
  AUTO_CONTINUE=1 \
  ENABLE_VNC=0 \
  VNC_PORT=6777 \
  NOVNC_PORT=6778

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    mkdir -p /data/browser /data/cloakbrowser /app/media \
  && npm ci --omit=dev --prefer-offline --ignore-scripts

VOLUME /data/browser /data/cloakbrowser

EXPOSE 6767 6777 6778

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "api"]
