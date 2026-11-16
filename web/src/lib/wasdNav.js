// App-wide keyboard navigation: W/A/S/D move a cursor between the controls on
// the page by where they sit on screen, Space (or Enter) presses the one under
// the cursor -- or puts the caret in it when it is a field. While a field has
// the caret every key belongs to the field; Escape or Enter hands it back.
//
// The Media page and the viewer already have their own meaning for these keys
// (move the file selection, seek). Both claim the key with preventDefault, and
// this listener sits on window, after them, and leaves a claimed key alone. The
// Media page hands over at the edges of its grid through leave(), and is told
// through a "wasd:media" event when the cursor walks back onto one of its files.

const CONTROL_Q = 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [data-wasd]';
const MEDIA_Q = '[data-testid="media-tile-file"], [data-testid="media-tile-folder"], [data-testid="media-tile-playlist"], [data-testid="media-tile-pile"], [data-testid="media-row"]';
const CUR_ATTR = "data-wasd-cur";

let cur = null;
// Where the cursor last was, in page coordinates: controls come and go as the
// page re-renders, and the next move starts from where the old one stood.
let lastRect = null;
let spaceHeld = false;

const isMedia = (el) => el.matches(MEDIA_Q);
const TEXTLESS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "image", "color"]);
export const isEditable = (t) => {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && !TEXTLESS.has(String(t.type || "").toLowerCase());
};

const toPage = (r) => ({ left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY });
const toView = (r) => ({ left: r.left - window.scrollX, top: r.top - window.scrollY, right: r.right - window.scrollX, bottom: r.bottom - window.scrollY });

// A dialog covers the page: while one is up the cursor stays inside it. Every
// dialog here is a fixed layer the size of the window, so that is the test.
function scopeRoot() {
  const marked = document.querySelectorAll("[data-wasd-scope]");
  if (marked.length) return marked[marked.length - 1];
  const W = window.innerWidth, H = window.innerHeight;
  for (const [x, y] of [[W / 2, H / 2], [3, 3], [W - 3, H - 3]]) {
    let el = document.elementFromPoint(x, y);
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (getComputedStyle(el).position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width >= W * 0.95 && r.height >= H * 0.95) return el;
    }
  }
  return document.body;
}

function usable(el) {
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  if (el.tagName === "INPUT" && el.type === "hidden") return false;
  if (el.closest("[data-wasd-skip]")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.pointerEvents !== "none";
}

function candidates(noMedia) {
  const root = scopeRoot();
  const out = [];
  for (const el of root.querySelectorAll(`${CONTROL_Q}, ${MEDIA_Q}`)) {
    if (isMedia(el)) {
      // A file is one stop, whatever buttons it carries; a pile is one stop too.
      if (noMedia || el.parentElement.closest(MEDIA_Q)) continue;
    } else if (el.closest(MEDIA_Q)) continue;
    if (usable(el)) out.push(el);
  }
  return out;
}

// The nearest control in a direction. One that lines up with the start (shares
// its column for up/down, its row for left/right) always beats one that does
// not; left/right will only leave the row for something more sideways than not.
function best(dir, from, list, skip) {
  const fx = (from.left + from.right) / 2, fy = (from.top + from.bottom) / 2;
  let hit = null, score = Infinity;
  for (const el of list) {
    if (el === skip) continue;
    const r = el.getBoundingClientRect();
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const vert = dir === "up" || dir === "down";
    const along = dir === "up" ? fy - y : dir === "down" ? y - fy : dir === "left" ? fx - x : x - fx;
    if (along <= 3) continue;
    const gap = dir === "up" ? from.top - r.bottom : dir === "down" ? r.top - from.bottom : dir === "left" ? from.left - r.right : r.left - from.right;
    const overlap = vert ? Math.min(r.right, from.right) - Math.max(r.left, from.left) : Math.min(r.bottom, from.bottom) - Math.max(r.top, from.top);
    const off = vert ? Math.abs(x - fx) : Math.abs(y - fy);
    let s;
    if (overlap > 0) s = Math.max(0, gap) + off * 0.3;
    else {
      if (!vert && off > along) continue;
      s = 40 + Math.max(0, gap) + (off - 0) * 3;
    }
    if (s < score) { score = s; hit = el; }
  }
  return hit;
}

function mark(el) {
  if (cur && cur !== el) cur.removeAttribute(CUR_ATTR);
  cur = el;
  if (el) { el.setAttribute(CUR_ATTR, ""); lastRect = toPage(el.getBoundingClientRect()); }
}

function land(el, dir, smooth) {
  if (isMedia(el)) {
    // The Media page shows its own selection there; the cursor steps aside.
    lastRect = toPage(el.getBoundingClientRect());
    mark(null);
    document.dispatchEvent(new CustomEvent("wasd:media", { detail: { el, dir } }));
    return;
  }
  mark(el);
  try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: smooth ? "smooth" : "auto" }); } catch {}
}

function scrollStep(dir, origin) {
  if (dir !== "up" && dir !== "down") return;
  const by = (dir === "down" ? 1 : -1) * Math.round(window.innerHeight * 0.4);
  for (let el = origin && origin.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
    const before = el.scrollTop;
    el.scrollBy({ top: by });
    if (el.scrollTop !== before) return;
  }
  window.scrollBy({ top: by });
}

function firstStop(list) {
  const here = list.find((el) => el.matches('a.active, a[aria-current="page"]'));
  if (here) return here;
  const H = window.innerHeight;
  let hit = null, score = Infinity;
  for (const el of list) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H) continue;
    const s = r.top * 4 + r.left;
    if (s < score) { score = s; hit = el; }
  }
  return hit || list[0] || null;
}

function move(dir, smooth) {
  const list = candidates(false);
  if (!list.length) { scrollStep(dir, null); return; }
  const live = cur && cur.isConnected && list.includes(cur);
  if (!live && !lastRect) { const el = firstStop(list); if (el) land(el, dir, smooth); return; }
  if (!live && cur) mark(null);
  const from = live ? cur.getBoundingClientRect() : toView(lastRect);
  const el = best(dir, from, list, live ? cur : null);
  if (!el) { scrollStep(dir, live ? cur : null); return; }
  // The next control is more than a screen away: that is a page of something
  // to read first, so scroll through it rather than jump over it.
  const r = el.getBoundingClientRect();
  if ((dir === "down" && r.top - from.bottom > window.innerHeight * 0.8) || (dir === "up" && from.top - r.bottom > window.innerHeight * 0.8)) {
    const edge = dir === "down" ? r.top > window.innerHeight : r.bottom < 0;
    if (edge) { scrollStep(dir, live ? cur : null); return; }
  }
  land(el, dir, smooth);
}

// A <select> opens the browser's own list, which script cannot move through.
// So the cursor gets a list of its own: the options as rows under the field,
// walked with W/S and chosen with Space like anything else, Escape to back out.
let picker = null;

function closePicker(back) {
  if (!picker) return;
  const { box, sel } = picker;
  picker = null;
  box.remove();
  if (back && sel.isConnected) mark(sel);
}

function openPicker(sel) {
  closePicker(false);
  const r = sel.getBoundingClientRect();
  const box = document.createElement("div");
  box.setAttribute("data-wasd-scope", "");
  box.className = "wasd-picker";
  const below = window.innerHeight - r.bottom, up = below < 200 && r.top > below;
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8))}px`;
  box.style.minWidth = `${Math.max(r.width, 160)}px`;
  box.style.maxHeight = `${Math.max(120, (up ? r.top : below) - 16)}px`;
  if (up) box.style.bottom = `${window.innerHeight - r.top + 6}px`; else box.style.top = `${r.bottom + 6}px`;
  let chosen = null;
  for (const o of sel.options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = o.label || o.text || o.value;
    b.disabled = o.disabled;
    if (o.selected) { b.setAttribute("data-on", ""); chosen = b; }
    b.addEventListener("click", () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      const changed = sel.value !== o.value;
      set.call(sel, o.value);
      if (changed) {
        // React hears about it through the events, not the property.
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closePicker(true);
    });
    box.appendChild(b);
  }
  document.body.appendChild(box);
  picker = { box, sel };
  const first = chosen || box.querySelector("button:not([disabled])");
  if (first) { mark(first); try { first.scrollIntoView({ block: "nearest" }); } catch {} }
}

function press(el) {
  if (el.tagName === "SELECT" && !el.multiple) { openPicker(el); return; }
  if (isEditable(el)) {
    el.focus();
    try { if (el.select && el.tagName !== "SELECT") el.select(); } catch {}
    return;
  }
  lastRect = toPage(el.getBoundingClientRect());
  el.click();
}

// Is the cursor out on the page (not on the Media page's own selection)?
export function roaming() {
  return !!cur && cur.isConnected;
}

// A menu was just opened from the keyboard: start the cursor on its first item.
export function enter() {
  if (!covered()) return;
  const el = candidates(true)[0];
  if (el) land(el, "down", false);
}

// Is a dialog or menu layer covering the page?
export function covered() {
  return scopeRoot() !== document.body;
}

// The Media page ran out of files in this direction: carry on to whatever
// control is there. False when there is nothing, and the page keeps the key.
export function leave(fromEl, dir) {
  if (!fromEl) return false;
  const el = best(dir, fromEl.getBoundingClientRect(), candidates(true), null);
  if (!el) return false;
  land(el, dir, true);
  return true;
}

const DIRS = { w: "up", a: "left", s: "down", d: "right" };

function onKeyDown(e) {
  const t = e.target;
  if (picker && !picker.sel.isConnected) closePicker(false);
  if (isEditable(t)) {
    // Escape or Enter gives the keys back, and the cursor is left on the field.
    if (e.key === "Escape") { mark(t); t.blur(); }
    else if (e.key === "Enter" && t.tagName !== "TEXTAREA" && !t.isContentEditable) {
      mark(t);
      setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0);
    }
    return;
  }
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  // The viewer keeps these keys for itself.
  if (document.querySelector(".fv-header")) return;
  const k = String(e.key || "").toLowerCase();
  if (DIRS[k]) {
    e.preventDefault();
    move(DIRS[k], !e.repeat);
    return;
  }
  if ((k === " " || k === "enter") && roaming()) {
    e.preventDefault();
    if (e.repeat) return;
    // A button clicked with the mouse earlier still has the browser's focus
    // and would be pressed by this same Space as well.
    const a = document.activeElement;
    if (a && a !== document.body && a !== cur && !isEditable(a) && a.blur) a.blur();
    spaceHeld = k === " ";
    press(cur);
  }
}

function onKeyUp(e) {
  if (e.key === " " && spaceHeld) { spaceHeld = false; e.preventDefault(); }
}

export function installWasdNav() {
  if (typeof window === "undefined" || window._xdlWasdNav) return;
  window._xdlWasdNav = true;
  window.addEventListener("keydown", onKeyDown);
  // Escape closes the option list and nothing else -- not the dialog under it.
  window.addEventListener("keydown", (e) => {
    if (!picker || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closePicker(true);
  }, true);
  window.addEventListener("keyup", onKeyUp, true);
  // A click anywhere is the mouse taking over: the cursor goes to what was
  // clicked if it is a control, and away otherwise.
  window.addEventListener("mousedown", (e) => {
    if (picker && !picker.box.contains(e.target)) closePicker(false);
    if (!cur) return;
    const el = e.target && e.target.closest ? e.target.closest(CONTROL_Q) : null;
    if (el && !el.closest(MEDIA_Q) && usable(el)) mark(el); else mark(null);
  }, true);
}
