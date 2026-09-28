let current = true;
const listeners = new Set();

export function kbdHintsEnabled() {
  return current;
}

export function subscribeKbdHints(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setKbdHints(on) {
  current = !!on;
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-kbd-hints", current ? "1" : "0");
  listeners.forEach((fn) => { try { fn(current); } catch {} });
}

export function loadKbdHints() {
  setKbdHints(true);
  fetch("/api/client-config")
    .then((r) => r.json())
    .then((j) => { if (j && typeof j.kbdHints === "boolean") setKbdHints(j.kbdHints); })
    .catch(() => {});
}
