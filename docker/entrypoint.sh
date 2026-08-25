#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
display_num="${DISPLAY#:}"
rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}" || true

# Always need Xvfb+fluxbox for headful browser (HEADLESS=0) even when VNC is off
Xvfb "$DISPLAY" -screen 0 1366x768x24 -ac +extension RANDR &
echo $! > /tmp/xvfb.pid
fluxbox >/tmp/fluxbox.log 2>&1 &
echo $! > /tmp/fluxbox.pid

# Bridge old host ports (7866:3000 etc via gluetun) to new internal ports
if command -v socat >/dev/null 2>&1; then
  [ "${PORT:-6767}" != "3000" ] && socat TCP-LISTEN:3000,fork,reuseaddr TCP:127.0.0.1:${PORT:-6767} >/tmp/socat-3000.log 2>&1 & echo $! > /tmp/socat-3000.pid || true
  [ "${VNC_PORT:-6777}" != "5900" ] && socat TCP-LISTEN:5900,fork,reuseaddr TCP:127.0.0.1:${VNC_PORT:-6777} >/tmp/socat-5900.log 2>&1 & echo $! > /tmp/socat-5900.pid || true
  [ "${NOVNC_PORT:-6778}" != "7900" ] && socat TCP-LISTEN:7900,fork,reuseaddr TCP:127.0.0.1:${NOVNC_PORT:-6778} >/tmp/socat-7900.log 2>&1 & echo $! > /tmp/socat-7900.pid || true
fi

VNC_FLAG="/data/browser/.vnc-enabled"
VNC_PORT_EFF="${VNC_PORT:-6777}"
NOVNC_PORT_EFF="${NOVNC_PORT:-6778}"

mkdir -p "$(dirname "$VNC_FLAG")"

# helper scripts callable from API (no procps needed — use pid files + /proc scan)
cat > /usr/local/bin/vnc-start <<EOS2
#!/usr/bin/env bash
set -e
VNC_PORT_EFF="\${VNC_PORT:-6777}"
NOVNC_PORT_EFF="\${NOVNC_PORT:-6778}"
DISPLAY_EFF="\${DISPLAY:-:99}"
VNC_FLAG="/data/browser/.vnc-enabled"
is_running_pid() { local pid="\$1"; [ -n "\$pid" ] || return 1; kill -0 "\$pid" 2>/dev/null || return 1; if [ -f "/proc/\$pid/status" ] && grep -q "^State:.*Z" "/proc/\$pid/status" 2>/dev/null; then return 1; fi; }
X_PID=\$(cat /tmp/x11vnc.pid 2>/dev/null || echo "")
if is_running_pid "\$X_PID"; then echo "x11vnc already running (\$X_PID)"; else
  # also kill stale by /proc scan if pid file missing but process lives
  for p in /proc/[0-9]*; do [ -f "\$p/cmdline" ] && grep -a -q "x11vnc.*\${VNC_PORT_EFF}" "\$p/cmdline" 2>/dev/null && kill "\$(basename \$p)" 2>/dev/null || true; done
  rm -f /tmp/x11vnc.pid
  x11vnc -display "\${DISPLAY_EFF}" -forever -shared -nopw -listen 0.0.0.0 -rfbport "\${VNC_PORT_EFF}" >/tmp/x11vnc.log 2>&1 &
  echo \$! > /tmp/x11vnc.pid
fi
N_PID=\$(cat /tmp/novnc.pid 2>/dev/null || echo "")
if is_running_pid "\$N_PID"; then echo "novnc already running (\$N_PID)"; else
  for p in /proc/[0-9]*; do [ -f "\$p/cmdline" ] && grep -a -q "novnc_proxy.*\${NOVNC_PORT_EFF}" "\$p/cmdline" 2>/dev/null && kill "\$(basename \$p)" 2>/dev/null || true; done
  # free the port if still held (websockify stuck)
  for p in /proc/[0-9]*; do [ -f "\$p/cmdline" ] && grep -a -q "websockify.*\${NOVNC_PORT_EFF}" "\$p/cmdline" 2>/dev/null && kill "\$(basename \$p)" 2>/dev/null || true; done
  sleep 0.5
  if [[ -f /usr/share/novnc/index.html ]]; then echo '<meta http-equiv="refresh" content="0; url=/vnc.html">' > /usr/share/novnc/index.html; fi
  /usr/share/novnc/utils/novnc_proxy --vnc "localhost:\${VNC_PORT_EFF}" --listen "\${NOVNC_PORT_EFF}" >/tmp/novnc.log 2>&1 &
  echo \$! > /tmp/novnc.pid
fi
mkdir -p "\$(dirname "\$VNC_FLAG")"
echo "1" > "\$VNC_FLAG"
EOS2
cat > /usr/local/bin/vnc-stop <<EOS2
#!/usr/bin/env bash
set -e
VNC_PORT_EFF="\${VNC_PORT:-6777}"
NOVNC_PORT_EFF="\${NOVNC_PORT:-6778}"
VNC_FLAG="/data/browser/.vnc-enabled"
for pidFile in /tmp/x11vnc.pid /tmp/novnc.pid; do
  if [ -f "\$pidFile" ]; then pid=\$(cat "\$pidFile" 2>/dev/null || echo ""); [ -n "\$pid" ] && kill "\$pid" 2>/dev/null || true; rm -f "\$pidFile"; fi
done
# fallback: scan /proc for any remaining x11vnc/novnc/websockify
for p in /proc/[0-9]*; do
  [ -f "\$p/cmdline" ] || continue
  if grep -a -q "x11vnc" "\$p/cmdline" 2>/dev/null; then kill "\$(basename \$p)" 2>/dev/null || true; fi
  if grep -a -q "novnc_proxy" "\$p/cmdline" 2>/dev/null; then kill "\$(basename \$p)" 2>/dev/null || true; fi
  if grep -a -q "websockify.*\${NOVNC_PORT_EFF}" "\$p/cmdline" 2>/dev/null; then kill "\$(basename \$p)" 2>/dev/null || true; fi
done
mkdir -p "\$(dirname "\$VNC_FLAG")"
echo "0" > "\$VNC_FLAG"
EOS2
chmod +x /usr/local/bin/vnc-start /usr/local/bin/vnc-stop
# ps shim for novnc_proxy (it does ps -p PID) — avoid needing procps
if [ ! -x /bin/ps ] && [ ! -x /usr/bin/ps ]; then
  cat > /usr/bin/ps <<'PSEOS'
#!/bin/sh
if [ "$1" = "-p" ] && [ -n "$2" ]; then pid="$2"; if kill -0 "$pid" 2>/dev/null; then echo "  PID TTY          TIME CMD"; echo " $pid ?        00:00:00 test"; exit 0; else exit 1; fi; fi
for d in /proc/[0-9]*; do [ -f "$d/cmdline" ] && echo "$(basename $d)"; done
exit 0
PSEOS
  chmod +x /usr/bin/ps
fi

# determine initial enabled state: flag file wins, else env
if [[ -f "$VNC_FLAG" ]]; then
  VNC_ENABLED=$(tr -d ' \n\r' < "$VNC_FLAG" 2>/dev/null || echo "0")
else
  VNC_ENABLED="${ENABLE_VNC:-0}"
  echo "$VNC_ENABLED" > "$VNC_FLAG"
fi

if [[ "$VNC_ENABLED" == "1" ]]; then
  /usr/local/bin/vnc-start || true
fi

exec "$@"
