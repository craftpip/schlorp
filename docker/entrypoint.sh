#!/usr/bin/env bash
set -euo pipefail

if [[ "${ENABLE_VNC:-0}" == "1" ]]; then
  export DISPLAY="${DISPLAY:-:99}"

  display_num="${DISPLAY#:}"
  rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}" || true

  Xvfb "$DISPLAY" -screen 0 1366x768x24 -ac +extension RANDR &
  fluxbox >/tmp/fluxbox.log 2>&1 &

  x11vnc \
    -display "$DISPLAY" \
    -forever \
    -shared \
    -nopw \
    -listen 0.0.0.0 \
    -rfbport "${VNC_PORT:-5900}" >/tmp/x11vnc.log 2>&1 &

  if [[ -f /usr/share/novnc/index.html ]]; then
    echo '<meta http-equiv="refresh" content="0; url=/vnc.html">' > /usr/share/novnc/index.html
  fi

  /usr/share/novnc/utils/novnc_proxy \
    --vnc "localhost:${VNC_PORT:-5900}" \
    --listen "${NOVNC_PORT:-7900}" >/tmp/novnc.log 2>&1 &
fi

exec "$@"
