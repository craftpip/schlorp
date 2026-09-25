import { useState, useEffect, useRef, useCallback } from "react";
import ShortcutsHelp from "./ShortcutsHelp";
import PlaylistHoverMenu from "./PlaylistHoverMenu.jsx";
import { usePlaylists } from "../store/PlaylistsContext.jsx";
import ConfirmModal from "./ConfirmModal.jsx";
import AlertModal from "./AlertModal.jsx";

const ROT_STORE_KEY = "xdl_viewer_rotations";
function readFileRotation(fp) {
  if (!fp) return 0;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    const v = Number(map[fp]);
    return v === 90 || v === 180 || v === 270 ? v : 0;
  } catch { return 0; }
}
function saveFileRotation(fp, deg) {
  if (!fp) return;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    if (deg % 360 === 0) delete map[fp];
    else map[fp] = deg;
    localStorage.setItem(ROT_STORE_KEY, JSON.stringify(map));
  } catch {}
}
const TRACK_CAP = 480;
const TRACK_TPL = 40;
// The identity fingerprint reads a wider window than the match template. A
// template-sized window holds a chunk of the subject, and any other subject has
// some chunk that looks like it; a wider one covers enough of the subject that
// something else would have to be the same subject to match.
const TRACK_ID = 56;
const TRACK_ROI = 52;
const TRACK_ROI_MAX = 220;
const TRACK_DEAD = 0.6;
const TRACK_PAN_SMOOTH = 0.45;
// The box stores the 0-10 display value; the pan lerp uses the inverted
// factor, so a higher number means a lower factor (more lag, slower follow).
const TRACK_SMOOTH_KEY = "xdl_viewer_smooth";
const TRACK_SMOOTH_UI_MAX = 10;
const readTrackSmoothUi = () => { try { const s = parseFloat(localStorage.getItem(TRACK_SMOOTH_KEY)); if (Number.isFinite(s)) return Math.min(TRACK_SMOOTH_UI_MAX, Math.max(0, s)); } catch {} return (1 - TRACK_PAN_SMOOTH) * TRACK_SMOOTH_UI_MAX; };
const trackSmoothFactorOf = (ui) => Math.max(0.05, 1 - Math.min(TRACK_SMOOTH_UI_MAX, Math.max(0, ui)) / TRACK_SMOOTH_UI_MAX);
// Auto-center: while stabilization runs, a deliberate off-center pan eases back
// to the middle so the view cannot drift out of the window. Only the user pan
// offset decays - the bg compensation and the tracked point are left alone, so
// this never weakens the stabilization itself.
const TRACK_AUTOCENTER_REACH = 0.2;
const TRACK_AUTOCENTER_PULL = 0.35;
const TRACK_AUTOCENTER_MAX = 2.2;
const TRACK_AUTOCENTER_MAXDRIFT = 0.5;
const TRACK_AUTOCENTER_EPS = 0.05;
const TRACK_HOLD_MS = 350;
// How hard a match is pulled towards the predicted position, per squared pixel.
// This has to stay small next to the size of the differences it is meant to
// overrule: a wrong match a few pixels away can easily be a couple of hundred
// worse than the right one, so a large stick term simply pins the search to
// where the subject was predicted to be. The subject then never actually gets
// picked up, it lags behind fast movement, and it is eventually declared lost.
const TRACK_STICK = 6;
// The clicked subject is fingerprinted once and every later match has to still
// look like that subject before it is accepted, so the point cannot slide off
// onto the background -- which is what used to leave it stuck on the spot the
// click was made at, unable to find the subject again when it came back.
//
// The fingerprint is a small brightness-normalised grid of one patch: one view,
// not a search over rotations and sizes. That is a deliberate limit. Scoring a
// patch against dozens of resampled views of the subject and taking the best
// looks more tolerant, but the best of dozens of chances is high for anything --
// measured here, a rotated view of the subject and a completely different
// subject both land around 0.93, so a bar loose enough to accept one accepts
// the other and the point jumps to a stranger. One view against one view
// separates them by a mile: the same subject scores about 1.0, an unrelated
// subject or a patch of background about 0.15.
//
// A subject that changes size or rotation while it is being followed is still
// handled, by moving the fingerprint towards it a little every frame (see
// subjectUpdate). Following a change as it happens is what makes the strict
// comparison workable, and it is the only safe way to do it: a fingerprint that
// was allowed to snap to whatever passed would drift onto the background within
// a dozen frames and confirm itself there.
const TRACK_DESC = 15;
// Pixels averaged per fingerprint cell. A single pixel says very little about
// identity -- in a smooth region every unrelated patch reads as the same soft
// blob -- but too much averaging leaves so little structure that two different
// patches line up with each other.
const TRACK_DESC_BOX = 2;
// Cells of shift the comparison allows for, in either direction. A grid sampled
// at fixed positions describes a patch a couple of pixels away as different
// texture, so without this the subject is lost the moment the point is not
// exactly on it -- and a comparison that sharp cannot tell "still on it" from
// "something else is here" at any threshold.
const TRACK_DESC_SHIFT = 2;
// What a match has to score to count as the subject. The same subject sits near
// 1.0 and an unrelated one near 0.15, so this sits in a wide empty gap rather
// than on a knife edge, and it also has to leave room for a subject that is
// changing: the fingerprint is a few frames behind, not the click.
const TRACK_KEEP = 0.75;
// Picking the subject back up out of the whole frame is held to a slightly
// higher bar than following it, because a full frame sweep offers a patch from
// every part of the picture rather than a handful of candidates near where the
// subject was last seen.
const TRACK_REACQ_KEEP = 0.85;
// How far the fingerprint moves towards an accepted patch per frame.
//
// This is the number that decides how much change the strict comparison above
// has to tolerate, because the fingerprint is what it is compared against: at a
// step of 0.15 it trails the subject by six or seven frames, and the comparison
// only forgives about five degrees of rotation or a five percent change of size,
// so anything turning or moving closer faster than that falls out of range and
// the subject is lost. At 0.5 it trails by about a frame, which is inside what
// the comparison forgives, and the memory of the original click is kept by the
// comparison itself: an unrelated patch scores about 0.15 and is rejected before
// it can move the fingerprint at all.
const TRACK_ANCHOR_BLEND = 0.5;
// A patch further from the fingerprint moves it faster, so a large change is
// caught up with instead of trailed.
const TRACK_ANCHOR_CATCHUP = 0.5;
// While lost the search window grows around the last known position (plus its
// velocity) until it can reach anywhere in the frame, so a subject that comes
// back is found again. The subject check is what keeps the point from settling
// on the background instead, so the window is allowed to grow wide.
const TRACK_REACQ = 40;
const TRACK_JUMP = 12;
const TRACK_TEX_MIN = 150;
const TRACK_BG_CLAMP = 0.35;
const TRACK_BG_DEAD = 0.15;
const TRACK_BG_LEAK = 0.0012;
const TRACK_BG_MISS = 10;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
// Median of an already-sorted array (the caller sorts; don't re-sort here).
// The mean of the two middle entries, not the upper one: picking a[n>>1] on an
// even count is the upper median, and these samples are fractional positions,
// so that index sits above the true median by a positive amount. Fed straight
// into a velocity that becomes a constant one-way creep, which is why the view
// used to drift up and left.
function medOf(a) {
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
function rotDeg(x, y, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return [x, y];
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
function capturePatchInto(img, rw, rh, cx, cy, size, buf) {
  const tw = Math.min(size, rw), th = Math.min(size, rh);
  const tx0 = clamp(Math.round(cx - tw / 2), 0, rw - tw);
  const ty0 = clamp(Math.round(cy - th / 2), 0, rh - th);
  const d = img.data, m = buf && buf.length >= tw * th ? buf : new Int32Array(tw * th);
  let vi = 0;
  for (let y = 0; y < th; y++) {
    let fi = ((ty0 + y) * rw + tx0) << 2;
    for (let x = 0; x < tw; x++) { m[vi] = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3; vi++; fi += 4; }
  }
  return { tpl: m, tplW: tw, tplH: th };
}
function capturePatch(img, rw, rh, cx, cy, size) {
  return capturePatchInto(img, rw, rh, cx, cy, size, null);
}
function captureTemplate(img, st, cx, cy) {
  const p = capturePatch(img, img.width, img.height, cx, cy, TRACK_TPL);
  st.tpl = p.tpl; st.tplW = p.tplW; st.tplH = p.tplH;
}
// Brightness-normalised grid over a patch: a short vector of how the light is
// spread across the middle of the patch. Unit length, so the dot product of two
// of them is their correlation. The length before normalising is kept too --
// it is how much texture the patch has, and a smooth patch correlates with
// whatever else is smooth, so it has to count for less.
function patchGrid(p, w, h) {
  const g = new Float64Array(TRACK_DESC * TRACK_DESC);
  // How far the grid reaches is worked out from the patch rather than fixed, so
  // every cell is a real pixel of the subject whatever size the patch is.
  const box = TRACK_DESC_BOX;
  const step2 = ((Math.min(w, h) / 2 - box * 1.6) * Math.SQRT2) / TRACK_DESC;
  let sum = 0;
  for (let gy = 0; gy < TRACK_DESC; gy++) {
    for (let gx = 0; gx < TRACK_DESC; gx++) {
      const dx = (gx + 0.5 - TRACK_DESC / 2) * step2, dy = (gy + 0.5 - TRACK_DESC / 2) * step2;
      const px = Math.round(dx + w / 2 - 0.5), py = Math.round(dy + h / 2 - 0.5);
      // Average a small box per cell rather than reading one pixel. Sparse
      // single-pixel samples say very little about identity -- in a smooth
      // region (skin, wall, sky) every unrelated patch ends up looking like the
      // same soft blob, and they all correlate with the subject.
      let v = 0, n = 0;
      for (let oy = 0; oy < box; oy++) {
        for (let ox = 0; ox < box; ox++) {
          const qx = px + ox, qy = py + oy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          v += p[qy * w + qx]; n++;
        }
      }
      const gv = n ? v / n : 0;
      g[gy * TRACK_DESC + gx] = gv; sum += gv;
    }
  }
  const mean = sum / g.length;
  let norm = 0;
  for (let i = 0; i < g.length; i++) { g[i] -= mean; norm += g[i] * g[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < g.length; i++) g[i] /= norm;
  return { g, e: norm };
}
// Correlation of two grids, each cell compared against its neighbour sx, sy cells
// away, scaled back up to the full grid so that comparing fewer cells is not
// mistaken for a weaker match.
function gridDot(a, b, sx, sy) {
  const d = TRACK_DESC;
  const x0 = sx > 0 ? sx : 0, x1 = d - (sx < 0 ? -sx : 0);
  const y0 = sy > 0 ? sy : 0, y1 = d - (sy < 0 ? -sy : 0);
  let dot = 0, n = 0;
  for (let gy = y0; gy < y1; gy++) {
    const ai = gy * d, bi = (gy - sy) * d;
    for (let gx = x0; gx < x1; gx++) { dot += a[ai + gx] * b[bi + gx - sx]; n++; }
  }
  return n ? (dot * d * d) / n : 0;
}
// The fingerprint of the clicked subject: one grid, plus how much texture it
// has, which is what later patches are counted against.
function subjectFingerprint(img, st, cx, cy) {
  const p = capturePatch(img, st.rw, st.rh, cx, cy, TRACK_ID);
  const v = patchGrid(p.tpl, p.tplW, p.tplH);
  st.tplD = v;
  st.tplE = v.e;
  return v;
}
// How much does this patch look like the subject? Near 1 for the subject itself,
// near 0.1 to 0.2 for anything else.
function subjectSame(st, patch) {
  const b = patchGrid(patch.tpl, patch.tplW, patch.tplH);
  // A patch with almost no detail correlates with whatever else has almost no
  // detail: normalising it on its own turns the leftover rounding error into a
  // shape, and then a wall or a sky lines up with any other wall. Scaling the
  // score by how much detail the patch really has stops that from counting as
  // the subject, and does it without asking the patch to match the subject's
  // exact brightness or contrast.
  const w = st.tplE > 0 ? Math.min(1, b.e / st.tplE) : 1;
  let m = -1;
  for (let sy = -TRACK_DESC_SHIFT; sy <= TRACK_DESC_SHIFT; sy++) {
    for (let sx = -TRACK_DESC_SHIFT; sx <= TRACK_DESC_SHIFT; sx++) {
      const d = gridDot(st.tplD.g, b.g, sx, sy);
      if (d > m) m = d;
    }
  }
  return m * w;
}
// Nudge the fingerprint towards a patch that has just been accepted as the
// subject. This is what lets a subject that is turning or moving closer be
// followed: the comparison above is deliberately strict, and the fingerprint is
// kept a little behind the subject so that a change spread over several frames
// stays inside what the strict comparison accepts. Only patches that already
// passed reach here, and the step grows with how far the patch is from the
// fingerprint, so a large change is caught up with sooner rather than trailing
// the subject for dozens of frames.
function subjectUpdate(st, patch) {
  const b = patchGrid(patch.tpl, patch.tplW, patch.tplH);
  const a = st.tplD;
  let dot = 0;
  for (let k = 0; k < a.g.length; k++) dot += a.g[k] * b.g[k];
  const step = clamp(TRACK_ANCHOR_BLEND + (1 - TRACK_ANCHOR_BLEND) * TRACK_ANCHOR_CATCHUP * (1 - dot), TRACK_ANCHOR_BLEND, 0.9);
  let norm = 0;
  for (let i = 0; i < a.g.length; i++) { a.g[i] += (b.g[i] - a.g[i]) * step; norm += a.g[i] * a.g[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < a.g.length; i++) a.g[i] /= norm;
  st.tplE += (b.e - st.tplE) * step;
}

// Sweep the whole frame for the subject by identity, not by how well it still
// fits the old picture of it. While lost this is the only search that can work:
// the SSD ranks candidates by resemblance to a fixed template, so a subject that
// came back turned or resized sorts behind a stranger that happens to look more
// like the old picture, and it is never even considered. Peaks are refined on
// the identity itself, which is what knows the subject.
function identitySearch(img, st) {
  if (!st.tplD) return null;
  const halfX = TRACK_ID >> 1, halfY = TRACK_ID >> 1;
  const buf = st.sweepBuf && st.sweepBuf.length >= TRACK_ID * TRACK_ID ? st.sweepBuf : (st.sweepBuf = new Int32Array(TRACK_ID * TRACK_ID));
  const stride = 8, peaks = [];
  // The whole sweep asks one question, the same question the strict gate will
  // ask: is the subject still here, unchanged, somewhere else in the frame.
  // One view and one shift search, so a position the sweep keeps is a position
  // the gate can accept. The sample grid can sit half a stride off the real
  // centre, so it is scored loosely here and exactly once the peak is walked
  // in; nothing is adopted on the loose score.
  const score = (x, y) => subjectSame(st, capturePatchInto(img, st.rw, st.rh, x, y, TRACK_ID, buf));
  const fit = (px, py, r, step) => {
    let bx = px, by = py, bm = -1;
    for (let dy = -r; dy <= r; dy += step) {
      for (let dx = -r; dx <= r; dx += step) {
        const x = px + dx, y = py + dy;
        if (x < halfX || y < halfY || x > st.rw - halfX || y > st.rh - halfY) continue;
        const m = score(x, y);
        if (m > bm) { bm = m; bx = x; by = y; }
      }
    }
    return { x: bx, y: by, m: bm };
  };
  for (let y = halfY; y <= st.rh - halfY; y += stride) {
    for (let x = halfX; x <= st.rw - halfX; x += stride) {
      const m = score(x, y);
      if (m < 0.6) continue;
      // keep the best of each cluster, so one subject cannot fill the list with
      // neighbouring samples of itself
      let dup = false;
      for (const pk of peaks) {
        if (Math.abs(pk.x - x) <= stride && Math.abs(pk.y - y) <= stride) { dup = true; if (m > pk.m) { pk.x = x; pk.y = y; pk.m = m; } break; }
      }
      if (!dup) peaks.push({ x, y, m });
    }
  }
  if (!peaks.length) return null;
  peaks.sort((a, b) => b.m - a.m);
  let best = null;
  for (const pk of peaks.slice(0, 6)) {
    // the stride can leave the peak several pixels off, so walk it in
    const coarse = fit(pk.x, pk.y, stride, 4);
    const fine = fit(coarse.x, coarse.y, 4, 1);
    if (fine.m < TRACK_REACQ_KEEP) continue;
    if (!best || fine.m > best.m) best = fine;
    if (fine.m > 0.97) break;
  }
  return best;
}
function refreshGrid(img, st) {
  const rw = st.rw, rh = st.rh, s = 32, m = s / 2 + 4;
  // The two midpoint points have to land on whole pixels. capturePatchInto
  // rounds where it reads, so a fractional point reads one patch and is then
  // recorded at the fractional coordinate, and every frame that cell reports a
  // displacement that is offset by that fraction for the life of the grid.
  const mx = Math.round(rw / 2), my = Math.round(rh / 2);
  const pts = [[m, m], [mx, m], [rw - m, m], [m, my], [rw - m, my], [m, rh - m], [mx, rh - m], [rw - m, rh - m]];
  st.grid = pts.map(([x, y]) => {
    const p = capturePatch(img, rw, rh, x, y, s);
    p.fx = clamp(x, 0, rw - 1); p.fy = clamp(y, 0, rh - 1); p.vx = 0; p.vy = 0;
    return p;
  });
}
function ssdAt(lum, st, base) {
  const tpl = st.tpl, tplW = st.tplW, tplH = st.tplH, rw = st.rw;
  let vi = 0, s = 0;
  for (let ty = 0; ty < tplH; ty++) {
    let li = base + ty * rw;
    for (let tx = 0; tx < tplW; tx++) { const dd = lum[li] - tpl[vi]; s += dd * dd; li++; vi++; }
  }
  return s;
}
function refineSpot(lum, st, bx, by, minX, maxX, minY, maxY, predX, predY, stickK, rad) {
  const halfX = st.tplW >> 1, halfY = st.tplH >> 1;
  let best = Infinity, bestRaw = Infinity, bxx = bx, byy = by;
  for (let dy = -rad; dy <= rad; dy++) {
    const cy = clamp(by + dy, minY, maxY);
    const baseY = (cy - halfY) * st.rw;
    for (let dx = -rad; dx <= rad; dx++) {
      const cx = clamp(bx + dx, minX, maxX);
      const s = ssdAt(lum, st, baseY + cx - halfX);
      const p = s + stickK * ((cx - predX) * (cx - predX) + (cy - predY) * (cy - predY));
      if (p < best) { best = p; bestRaw = s; bxx = cx; byy = cy; }
    }
  }
  let fx = bxx, fy = byy;
  if (bxx > minX && bxx < maxX && byy > minY && byy < maxY) {
    const s0 = ssdAt(lum, st, (byy - halfY) * st.rw + bxx - halfX);
    const sxm = ssdAt(lum, st, (byy - halfY) * st.rw + bxx - 1 - halfX);
    const sxp = ssdAt(lum, st, (byy - halfY) * st.rw + bxx + 1 - halfX);
    const sym = ssdAt(lum, st, (byy - 1 - halfY) * st.rw + bxx - halfX);
    const syp = ssdAt(lum, st, (byy + 1 - halfY) * st.rw + bxx - halfX);
    const dxn = sxm - 2 * s0 + sxp, dyn = sym - 2 * s0 + syp;
    if (dxn > 0) fx = bxx + clamp((sxm - sxp) / (2 * dxn), -0.5, 0.5);
    if (dyn > 0) fy = byy + clamp((sym - syp) / (2 * dyn), -0.5, 0.5);
  }
  return { x: fx, y: fy, score: bestRaw };
}
function bestTemplateSearch(img, st, predX, predY, wide, roi, stick, topN) {
  const len = st.rw * st.rh;
  let lum = st.lum;
  if (!lum || lum.length < len) { lum = new Int32Array(len); st.lum = lum; }
  const d = img.data;
  for (let n = 0, fi = 0; fi < d.length; fi += 4, n++) lum[n] = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3;
  const halfX = st.tplW >> 1, halfY = st.tplH >> 1;
  const step = wide ? 6 : 3;
  const rng = roi || TRACK_ROI;
  const stickK = stick == null ? TRACK_STICK : stick;
  // The scan has to land on whole pixels. A fractional start (which is what a
  // fractional window radius produces) walks the whole sample grid off the
  // pixel grid, so the position the subject is actually on is never sampled
  // and the search reports a worse match somewhere else instead.
  const minX = Math.max(halfX, Math.min(st.rw - halfX, Math.round(predX - rng)));
  const maxX = Math.min(st.rw - halfX, Math.max(halfX, Math.round(predX + rng)));
  const minY = Math.max(halfY, Math.min(st.rh - halfY, Math.round(predY - rng)));
  const maxY = Math.min(st.rh - halfY, Math.max(halfY, Math.round(predY + rng)));
  let best = Infinity, bestRaw = Infinity, bx = Math.round(predX), by = Math.round(predY);
  if (maxX < minX || maxY < minY) return { x: bx, y: by, score: bestRaw };
  // topN keeps the best few peaks instead of only the best one, so a caller
  // that has a second opinion (the identity check) can pick between them.
  const keep = topN > 1 ? [] : null;
  for (let cy = minY; cy <= maxY; cy += step) {
    const baseY = (cy - halfY) * st.rw;
    for (let cx = minX; cx <= maxX; cx += step) {
      const s = ssdAt(lum, st, baseY + cx - halfX);
      const p = s + stickK * ((cx - predX) * (cx - predX) + (cy - predY) * (cy - predY));
      if (p < best) { best = p; bestRaw = s; bx = cx; by = cy; }
      if (keep) {
        let near = false;
        for (const k of keep) if (Math.abs(k.x - cx) <= step && Math.abs(k.y - cy) <= step) { near = true; break; }
        if (!near) {
          keep.push({ p, x: cx, y: cy });
          keep.sort((a, b) => a.p - b.p);
          if (keep.length > topN) keep.length = topN;
        }
      }
    }
  }
  // A wide scan steps further between samples, so the refinement has to reach
  // the whole stride, otherwise the best sample can sit up to a stride off the
  // real position and never get corrected.
  const rad = wide ? 3 : 2;
  if (!keep) return refineSpot(lum, st, bx, by, minX, maxX, minY, maxY, predX, predY, stickK, rad);
  const spots = keep.map((k) => refineSpot(lum, st, k.x, k.y, minX, maxX, minY, maxY, predX, predY, stickK, rad));
  spots.sort((a, b) => a.score - b.score);
  return spots;
}
function parseFolderBase(fp) {
  const raw = String(fp || "");
  const idx = raw.indexOf("/media/");
  const without = idx !== -1 ? raw.slice(idx + 7) : raw.replace(/^\/+/, "").replace(/^media\//, "");
  const parts = without.split("/").filter(Boolean);
  if (!parts.length) return { folder: "", base: "" };
  const base = parts.pop();
  return { folder: parts.join("/"), base };
}
function toMediaUrlLocal(fp) {
  if (!fp) return "";
  const s = String(fp);
  const idx = s.indexOf("/media/");
  if (idx !== -1) return s.slice(idx);
  return s.startsWith("/media/") ? s : s.startsWith("media/") ? `/${s}` : s.startsWith("/") ? s : `/${s}`;
}
function deriveTitleLocal(url, filePath) {
  if (filePath) {
    const base = String(filePath).split("/").pop() || "";
    return base.replace(/-\d+\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || url;
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
    if (decoded.length > 3) return decoded.length > 60 ? decoded.slice(0, 60) + "…" : decoded;
    return u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 40);
  } catch { return url; }
}
export default function FileViewer({ src, title, filePath, url, file, viewable, idx, onPrev, onNext, onGoto, onClose, onDeleted }) {
  const effFilePath = filePath || file?.filePath || "";
  const effUrl = url || file?.url || "";
  const effSrc = src || (effFilePath ? toMediaUrlLocal(effFilePath) : "");
  const effTitle = title || deriveTitleLocal(effUrl, effFilePath);
  const filePathEff = effFilePath;
  const videoRef = useRef(null);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const [rate, setRate] = useState(() => { try { const v = parseFloat(localStorage.getItem("xdl_viewer_rate")); if (!Number.isNaN(v) && v >= 0.1 && v <= 1) return v; } catch {} return 1; });
  const [isPlaying, setIsPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState("50% 50%");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotate, setRotate] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const rotLoadedRef = useRef("");
  const [isFs, setIsFs] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [trackLost, setTrackLost] = useState(false);
  const [trackBg, setTrackBg] = useState(false);
  const [trackHover, setTrackHover] = useState(false);
  const [dotVisible, setDotVisible] = useState(false);
  const dotTimerRef = useRef(0);
  const pokeDot = () => {
    setDotVisible(true);
    if (dotTimerRef.current) clearTimeout(dotTimerRef.current);
    dotTimerRef.current = setTimeout(() => setDotVisible(false), 400);
  };
  const [trackMiss, setTrackMiss] = useState(false);
  const missTimerRef = useRef(0);
  const [trackArmed, setTrackArmed] = useState(false);
  const trackArmedRef = useRef(false);
  const trackingRef = useRef(false);
  const trackGenRef = useRef(0);
  const trackViewRef = useRef({ tracking: false, zoom: 1, pan: { x: 0, y: 0 }, transform: "" });
  const trackSmoothRef = useRef(trackSmoothFactorOf(readTrackSmoothUi()));
  // Auto-center is on by default; holding the recenter button toggles it.
  const [autoCenter, setAutoCenter] = useState(true);
  const autoCenterRef = useRef(true);
  const holdRef = useRef({ timer: null, fired: false });
  const clearHoldTimer = () => {
    const h = holdRef.current;
    if (h.timer) { clearTimeout(h.timer); h.timer = null; }
  };
  const toggleAutoCenter = () => {
    const next = !autoCenterRef.current;
    autoCenterRef.current = next;
    setAutoCenter(next);
  };
  // Holding T mirrors holding the recenter button: it toggles auto-centering and
  // never touches tracking. A short press still recenters, and a hold must not
  // also fire that.
  const tHoldRef = useRef({ timer: null, fired: false });
  const clearHold = (r) => {
    if (r.current.timer) { clearTimeout(r.current.timer); r.current.timer = null; }
  };
  const beginHold = (r, fn) => {
    clearHold(r);
    r.current.fired = false;
    r.current.timer = setTimeout(() => { r.current.timer = null; r.current.fired = true; fn(); }, TRACK_HOLD_MS);
  };
  const heldRecently = (r) => {
    if (!r.current.fired) return false;
    r.current.fired = false;
    return true;
  };
  // Single writer for the smooth value: the typed onChange and the wheel
  // listener both go through here. The wheel path cannot rely on React's
  // onChange — setting el.value directly is swallowed by React's value
  // tracker, so the input would move while the pan lerp kept the old factor.
  const applyTrackSmoothUi = (ui) => {
    const clamped = Math.min(TRACK_SMOOTH_UI_MAX, Math.max(0, ui));
    trackSmoothRef.current = trackSmoothFactorOf(clamped);
    try { localStorage.setItem(TRACK_SMOOTH_KEY, String(clamped)); } catch {}
  };
  const applyTrackSmoothUiRef = useRef(applyTrackSmoothUi);
  applyTrackSmoothUiRef.current = applyTrackSmoothUi;
  const smoothInputRef = useRef(null);
  const trackStateRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const wasPlayingRef = useRef(false);
  const shiftWasPlayingRef = useRef(false);
  const jogRef = useRef(null);
  const jogWasPlayingRef = useRef(false);
  const jogGenRef = useRef(0);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekFrames, setSeekFrames] = useState(() => { try { return localStorage.getItem("xdl_viewer_seekFrames") === "1"; } catch { return false; } });
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("xdl_viewer_muted") === "1"; } catch { return false; } });
  const [trackPref, setTrackPref] = useState(() => { try { const p = localStorage.getItem("xdl_viewer_track"); return p === "bg" || p === "point" ? p : "none"; } catch { return "none"; } });
  const [endMode, setEndMode] = useState(() => { try { const v = localStorage.getItem("xdl_viewer_endMode"); if (v === "stop") return "next"; if (v === "repeat" || v === "random") return v; return "none"; } catch { return "none"; } });
  const [randHistory, setRandHistory] = useState([]);
  const [randCursor, setRandCursor] = useState(-1);
  const randHistoryRef = useRef([]);
  const [yConfirm, setYConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [fHeld, setFHeld] = useState(false);
  const fHeldRef = useRef(false);
  const { playlists: fvPlaylists, toggleItem: fvToggleItem } = usePlaylists();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alertState, setAlertState] = useState({ open: false, title: "", message: "" });
  const playlistHoverRef = useRef(null);
  const playlistCloseTimer = useRef(null);
  // `.gif` files that are actually MP4 bytes (mislabeled at download time)
  // fail in <img> — flip to a <video> element on image error.
  const [gifAsVideo, setGifAsVideo] = useState(false);
  const lastYRef = useRef(0);
  const yConfirmTimerRef = useRef(null);
  const doDeleteFileRef = useRef(null);
  const startBgRef = useRef(null);
  const cycleTrackRef = useRef(null);
  const autoCenterToggleRef = useRef(null);
  const recenterRef = useRef(null);
  const trackPrefRef = useRef(trackPref);
  trackPrefRef.current = trackPref;
  const applyTrackPrefRef = useRef(null);
  const randCursorRef = useRef(-1);
  const fmtTime = (s) => { if (!s || Number.isNaN(s)) return "0:00"; const m = Math.floor(s/60); const sec = String(Math.floor(s%60)).padStart(2,"0"); return `${m}:${sec}`; };
  const mediaUrl = effSrc;
  const navRef = useRef(mediaUrl);
  const [loadedUrl, setLoadedUrl] = useState(mediaUrl);
  const loadTimerRef = useRef(null);
  const seekRef = useRef(null);
  const animRef = useRef(null);
  const rafRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const pressedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const pressStartRef = useRef({ x: 0, y: 0 });
  const [mediaReady, setMediaReady] = useState(false);
  useEffect(() => {
    navRef.current = mediaUrl;
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => { if (navRef.current === mediaUrl) setLoadedUrl(mediaUrl); }, 150);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [mediaUrl]);
  const loading = mediaUrl !== loadedUrl;
  const titleEff = effTitle;
  const urlEff = effUrl;
  const ext = String(filePathEff || effSrc || "").split(".").pop()?.toLowerCase() || "";
  const isVideo = /^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext);
  const isAudio = /^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext);
  const isImage = /^(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(ext);
  const isGif = ext === "gif";
  const gifAsVideoEff = isGif && gifAsVideo;
  const showImage = isImage && !gifAsVideoEff;
  const isFormatKnown = isVideo || isAudio || isImage;
  const hasPrev = idx != null && idx > 0;
  const hasNext = idx != null && viewable && idx < viewable.length - 1;
  const total = viewable ? viewable.length : 0;
  const transposed = rotate === 90 || rotate === 270;
  const mediaW = transposed && stageSize.w && stageSize.h ? stageSize.h : "100%";
  const mediaH = transposed && stageSize.w && stageSize.h ? stageSize.w : "100%";
  const videoishRef = useRef(false);
  videoishRef.current = isVideo || gifAsVideoEff;
  const showImageRef = useRef(false);
  showImageRef.current = showImage;
  const rotateRef = useRef(0);
  rotateRef.current = rotate;
  const stageSizeRef = useRef({ w: 0, h: 0 });
  stageSizeRef.current = stageSize;

  const stepRate = (delta) => {
    setRate((r) => Math.min(1, Math.max(0.1, Math.round((r + delta) * 10) / 10)));
  };
  const toggleFullscreen = () => {
    const el = viewerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().then(() => el.requestFullscreen().catch(() => {})).catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate, loadedUrl]);
  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted, loadedUrl]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_muted", muted ? "1" : "0"); } catch {} }, [muted]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_track", trackPref); } catch {} }, [trackPref]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_rate", String(rate)); } catch {} }, [rate]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_seekFrames", seekFrames ? "1" : "0"); } catch {} }, [seekFrames]);
  const stopTracking = useCallback(() => {
    if (!trackingRef.current && !trackStateRef.current) { setTracking(false); return; }
    trackingRef.current = false;
    trackGenRef.current++;
    const st = trackStateRef.current;
    trackStateRef.current = null;
    if (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      const v = videoRef.current;
      if (v && st.onSeeked) v.removeEventListener("seeked", st.onSeeked);
    }
    trackViewRef.current = { tracking: false, zoom: 1, pan: { x: 0, y: 0 }, transform: "" };
    setTracking(false);
    setTrackLost(false);
    setTrackBg(false);
    setTrackHover(false);
    if (dotTimerRef.current) clearTimeout(dotTimerRef.current);
    setDotVisible(false);
    setZoom(1);
    setOrigin("50% 50%");
    setPan({ x: 0, y: 0 });
  }, []);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_endMode", endMode); } catch {} }, [endMode]);
  useEffect(() => { if (rotLoadedRef.current !== filePathEff) return; saveFileRotation(filePathEff, rotate); }, [rotate, filePathEff]);
  useEffect(() => { stopTracking(); rotLoadedRef.current = filePathEff; setZoom(1); setOrigin("50% 50%"); setPan({x:0,y:0}); setRotate(readFileRotation(filePathEff)); setCurrent(0); setDuration(0); setGifAsVideo(false); setMediaReady(false); setYConfirm(false); lastYRef.current = 0; animRef.current = null; pendingSeekRef.current = null; if (yConfirmTimerRef.current) { clearTimeout(yConfirmTimerRef.current); yConfirmTimerRef.current = null; } setTimeout(() => videoRef.current?.focus(), 50); }, [loadedUrl, filePathEff, stopTracking]);
  useEffect(() => { if (!mediaReady) return; if (applyTrackPrefRef.current) applyTrackPrefRef.current(); }, [mediaReady, loadedUrl]);
  // Drive the seekbar with requestAnimationFrame: read the video's live
  // currentTime every frame so the thumb glides instead of stepping with the
  // ~4/s timeupdate events. Any seek (keyboard, wheel, ±10s, track click, or
  // loop restart) sets a pending target that the thumb flies to with a short
  // easeOut glide; an active pointer drag cancels the flight and tracks the
  // pointer directly.
  const seekTo = useCallback((nt) => {
    const v = videoRef.current;
    if (!v) return;
    const lim = Number.isFinite(v.duration) ? v.duration : 1e9;
    const t = Math.max(0, Math.min(lim, typeof nt === "number" && Number.isFinite(nt) ? nt : 0));
    pendingSeekRef.current = t;
    v.currentTime = t;
    setCurrent(t);
  }, []);
  useEffect(() => {
    const frame = () => {
      rafRef.current = requestAnimationFrame(frame);
      const el = seekRef.current;
      const v = videoRef.current;
      if (!v || !el) return;
      const max = Number.isFinite(v.duration) ? v.duration : duration || 0;
      const now = performance.now();
      const a = animRef.current;
      if (a) {
        if (pendingSeekRef.current != null && Math.abs(pendingSeekRef.current - a.to) > 0.01) {
          const cur = a.from + (a.to - a.from) * (1 - Math.pow(1 - Math.min(1, (now - a.start) / a.dur), 3));
          a.from = cur;
          a.to = Math.max(0, Math.min(max, pendingSeekRef.current));
          a.start = now;
          pendingSeekRef.current = null;
        }
        const q = Math.min(1, (now - a.start) / a.dur);
        const eased = 1 - Math.pow(1 - q, 3);
        const shown = a.from + (a.to - a.from) * eased;
        if (Math.abs(el.valueAsNumber - shown) > 0.005) el.value = String(shown);
        if (q >= 1) animRef.current = null;
        return;
      }
      if (pendingSeekRef.current != null) {
        const to = Math.max(0, Math.min(max, pendingSeekRef.current));
        if (Math.abs(to - el.valueAsNumber) > 0.01) animRef.current = { from: el.valueAsNumber, to, start: now, dur: 280 };
        else pendingSeekRef.current = null;
        return;
      }
      const t = v.currentTime;
      if (Math.abs(el.valueAsNumber - t) > 0.01 && t <= max) el.value = String(t);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); animRef.current = null; pendingSeekRef.current = null; };
  }, [loadedUrl, duration]);
  // The loading gate above unmounts the <img> while debouncing, then remounts
  // it — grid thumbnails are the full photo bytes, so the remount is usually
  // cache-complete before insertion and onLoad never fires. Detect that so a
  // navigated-to photo never sticks at opacity 0 behind the spinner.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setMediaReady(true);
  }, [loadedUrl]);
  useEffect(() => () => { if (yConfirmTimerRef.current) clearTimeout(yConfirmTimerRef.current); if (playlistCloseTimer.current) clearTimeout(playlistCloseTimer.current); }, []);
  const navigatingViaRandomRef = useRef(false);
  useEffect(() => {
    if (navigatingViaRandomRef.current) { navigatingViaRandomRef.current = false; return; }
    setRandHistory([]);
    setRandCursor(-1);
    randHistoryRef.current = [];
    randCursorRef.current = -1;
  }, [idx]);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === viewerRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const showPlaylistRef = useRef(showPlaylist);
  useEffect(() => { showPlaylistRef.current = showPlaylist; }, [showPlaylist]);
  const endModeRef = useRef(endMode);
  endModeRef.current = endMode;
  const viewableRef = useRef(viewable);
  viewableRef.current = viewable;
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const onGotoRef = useRef(onGoto);
  onGotoRef.current = onGoto;
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const onPrevRef = useRef(onPrev);
  onPrevRef.current = onPrev;
  const hasNextRef = useRef(hasNext);
  hasNextRef.current = hasNext;

  const pickRandomDifferent = (total, exclude) => {
    if (total <= 1) return exclude;
    const r = Math.floor(Math.random() * (total - 1));
    return r >= exclude ? r + 1 : r;
  };

  const dispatchNext = () => {
    const v = viewableRef.current;
    if (!v || !v.length) return;
    if (endModeRef.current === "random") {
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      if (cur < hist.length - 1) {
        const next = cur + 1;
        setRandCursor(next);
        randCursorRef.current = next;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(hist[next]);
      } else {
        const newIdx = pickRandomDifferent(v.length, idxRef.current);
        const newHist = [...hist.slice(0, cur + 1), newIdx];
        setRandHistory(newHist);
        setRandCursor(cur + 1);
        randHistoryRef.current = newHist;
        randCursorRef.current = cur + 1;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(newIdx);
      }
    } else {
      onNextRef.current();
    }
  };

  const dispatchPrev = () => {
    const v = viewableRef.current;
    if (!v || !v.length) return;
    if (endModeRef.current === "random") {
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      if (cur > 0) {
        const prev = cur - 1;
        setRandCursor(prev);
        randCursorRef.current = prev;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(hist[prev]);
      } else {
        const newIdx = pickRandomDifferent(v.length, idxRef.current);
        const newHist = [newIdx, ...hist];
        setRandHistory(newHist);
        setRandCursor(0);
        randHistoryRef.current = newHist;
        randCursorRef.current = 0;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(newIdx);
      }
    } else {
      onPrevRef.current();
    }
  };

  const dispatchNextRef = useRef(dispatchNext);
  dispatchNextRef.current = dispatchNext;
  const dispatchPrevRef = useRef(dispatchPrev);
  dispatchPrevRef.current = dispatchPrev;

  const handleVideoEndedRef = useRef(null);
  handleVideoEndedRef.current = () => {
    const mode = endModeRef.current;
    const v = viewableRef.current;
    const i = idxRef.current;
    const hasN = hasNextRef.current;
    setIsPlaying(false);
    if (mode === "next") {
      if (hasN) onNextRef.current();
    } else if (mode === "repeat") {
      if (videoRef.current) { seekTo(0); videoRef.current.play().catch(() => {}); }
      // Loop restart: the accumulated stabilization offsets belong to the
      // previous playthrough, so drop them instead of letting them pile up.
      if (trackingRef.current) recenterView();
    } else if (mode === "random" && v && v.length > 1) {
      const newIdx = pickRandomDifferent(v.length, i);
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      const newHist = [...hist.slice(0, cur + 1), newIdx];
      setRandHistory(newHist);
      setRandCursor(cur + 1);
      randHistoryRef.current = newHist;
      randCursorRef.current = cur + 1;
      navigatingViaRandomRef.current = true;
      if (onGotoRef.current) onGotoRef.current(newIdx);
    }
  };
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const handler = () => { if (handleVideoEndedRef.current) handleVideoEndedRef.current(); };
    el.addEventListener("ended", handler);
    return () => el.removeEventListener("ended", handler);
  }, [loadedUrl]);
  const cycleEndMode = () => setEndMode((m) => m === "none" ? "next" : m === "next" ? "repeat" : m === "repeat" ? "random" : "none");
  const cycleEndModeRef = useRef(cycleEndMode);
  cycleEndModeRef.current = cycleEndMode;
  const computeCenterPan = (st, z, rect, rot) => {
    const v = videoRef.current;
    if (!v) return { x: 0, y: 0 };
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return { x: 0, y: 0 };
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const [rdx, rdy] = rotDeg((dimW - cw) / 2 + st.fx * st.cPerCanvas - dimW / 2, (dimH - ch) / 2 + st.fy * st.cPerCanvas - dimH / 2, rot);
    return { x: -rdx * z + (st.offX || 0), y: -rdy * z + (st.offY || 0) };
  };
  const handleWheel = (e) => {
    if (e.shiftKey) {
      if ((isVideo || isAudio || gifAsVideoEff) && videoRef.current) {
        e.preventDefault();
        const d = seekFrames ? 1/30 : 1;
        const raw = (e.deltaY !== 0 ? e.deltaY : e.deltaX !== 0 ? e.deltaX : e.wheelDelta ? -e.wheelDelta : 0);
        if (raw === 0) return;
        const delta = raw < 0 ? d : -d;
        const v = videoRef.current;
        const nt = Math.max(0, Math.min(duration || v.duration || Infinity, v.currentTime + delta));
        seekTo(nt);
        return;
      }
      e.preventDefault();
      return;
    }
    if (isAudio) return;
    if (trackingRef.current) {
      const st = trackStateRef.current;
      if (!st) return;
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const perLine = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
      const z = Math.min(4, Math.max(1, trackViewRef.current.zoom * Math.exp(-e.deltaY * perLine * 0.0022)));
      if (z === trackViewRef.current.zoom) return;
      const rot = rotateRef.current;
      const pan = st.mode === "bg"
        ? { x: st.bgX * st.cPerCanvas * z + (st.offX || 0), y: st.bgY * st.cPerCanvas * z + (st.offY || 0) }
        : computeCenterPan(st, z, rect, rot);
      trackViewRef.current.zoom = z;
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${z})`;
      const v = videoRef.current;
      if (v) v.style.transform = trackViewRef.current.transform;
      setZoom(z);
      setPan(pan);
      return;
    }
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const perLine = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
    const newZoom = Math.min(4, Math.max(1, zoom * Math.exp(-e.deltaY * perLine * 0.0022)));
    if (newZoom === zoom) return;
    if (newZoom === 1) { setZoom(1); setPan({x:0,y:0}); setOrigin("50% 50%"); return; }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const Cx = e.clientX - cx;
    const Cy = e.clientY - cy;
    const ratio = newZoom / zoom;
    const newPan = { x: Cx - (Cx - pan.x) * ratio, y: Cy - (Cy - pan.y) * ratio };
    setZoom(newZoom);
    setPan(newPan);
    setOrigin("50% 50%");
  };
  const resetZoom = () => { setZoom(1); setOrigin("50% 50%"); setPan({x:0,y:0}); };
  const rotateFile = () => setRotate((r) => (r + 90) % 360);
  const handleStageClick = (e) => {
    if (!trackArmedRef.current) return;
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO" || showImageRef.current) return;
    e.preventDefault();
    if (!startTracking(e.clientX, e.clientY)) {
      setTrackMiss(true);
      if (missTimerRef.current) clearTimeout(missTimerRef.current);
      missTimerRef.current = setTimeout(() => setTrackMiss(false), 1400);
    } else {
      setTrackMiss(false);
    }
  };
  const startTracking = (clientX, clientY) => {
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO" || showImageRef.current) return false;
    const rect = containerRef.current && containerRef.current.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return false;
    const rot = rotateRef.current;
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return false;
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const eff = trackingRef.current ? trackViewRef.current : { zoom, pan };
    const z = eff.zoom;
    const ix = (clientX - rect.left - sw / 2 - eff.pan.x) / z;
    const iy = (clientY - rect.top - sh / 2 - eff.pan.y) / z;
    const [ux, uy] = rotDeg(ix, iy, -rot);
    const elX = ux + dimW / 2, elY = uy + dimH / 2;
    const tlX = (dimW - cw) / 2, tlY = (dimH - ch) / 2;
    const cpx = elX - tlX, cpy = elY - tlY;
    if (cpx < 3 || cpy < 3 || cpx > cw - 3 || cpy > ch - 3) return false;
    stopTracking();
    const st = {
      canvas: document.createElement("canvas"),
      ctx: null, rw: 0, rh: 0, cPerCanvas: 1, lum: null,
      tpl: null, tplW: 0, tplH: 0, tplD: null,
      fx: 0, fy: 0, vx: 0, vy: 0, age: 0, recapture: false, offX: 0, offY: 0, lost: false, misses: 0, frames: 0,
      rvfc: typeof v.requestVideoFrameCallback === "function",
      raf: 0, tTime: -1, gen: ++trackGenRef.current,
      onSeeked: () => { const s = trackStateRef.current; if (s) { s.recapture = true; s.vx = 0; s.vy = 0; } },
    };
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    st.canvas.width = rw; st.canvas.height = rh;
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    st.ctx = st.canvas.getContext("2d", { willReadFrequently: true });
    st.ctx.drawImage(v, 0, 0, rw, rh);
    const img = st.ctx.getImageData(0, 0, rw, rh);
    st.fx = clamp(cpx / st.cPerCanvas, 0, rw - 1);
    st.fy = clamp(cpy / st.cPerCanvas, 0, rh - 1);
    captureTemplate(img, st, st.fx, st.fy);
    st.tplD = subjectFingerprint(img, st, st.fx, st.fy);
    let tMean = 0;
    const tLen = st.tpl ? st.tpl.length : 0;
    for (let ti = 0; ti < tLen; ti++) tMean += st.tpl[ti];
    tMean = tLen ? tMean / tLen : 0;
    let tVar = 0;
    for (let ti = 0; ti < tLen; ti++) { const dd = st.tpl[ti] - tMean; tVar += dd * dd; }
    st.tex = tLen ? tVar / tLen : 0;
    refreshGrid(img, st);
    st.offX = clientX - rect.left - sw / 2;
    st.offY = clientY - rect.top - sh / 2;
    trackStateRef.current = st;
    trackingRef.current = true;
    const cz = Math.max(1, zoom);
    const pan0 = computeCenterPan(st, cz, rect, rot);
    trackViewRef.current = { tracking: true, zoom: cz, pan: pan0, transform: `translate(${pan0.x}px, ${pan0.y}px) rotate(${rot}deg) scale(${cz})` };
    v.style.transformOrigin = "50% 50%";
    v.style.transform = trackViewRef.current.transform;
    v.addEventListener("seeked", st.onSeeked);
    trackArmedRef.current = false;
    setTrackArmed(false);
    setTrackLost(false);
    setTrackHover(false);
    pokeDot();
    setZoom(cz);
    setPan(pan0);
    setOrigin("50% 50%");
    setTracking(true);
    st.step = () => {
      if (trackGenRef.current !== st.gen || !trackingRef.current) return;
      if (st.rvfc) { v.requestVideoFrameCallback(st.step); trackingTick(); }
      else { st.raf = requestAnimationFrame(st.step); trackingTick(); }
    };
    st.step();
    return true;
  };
  const startBgTracking = () => {
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO" || showImageRef.current) return false;
    const rect = containerRef.current && containerRef.current.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return false;
    const rot = rotateRef.current;
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return false;
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    stopTracking();
    const st = {
      canvas: document.createElement("canvas"),
      ctx: null, rw: 0, rh: 0, cPerCanvas: 1, lum: null,
      tpl: null, tplW: 0, tplH: 0,
      fx: 0, fy: 0, vx: 0, vy: 0, age: 0, recapture: false, offX: 0, offY: 0, lost: false, misses: 0, frames: 0,
      mode: "bg", grid: null, gridRW: -1, gridRH: -1, warm: 3,
      bgX: 0, bgY: 0, bgVX: 0, bgVY: 0, bgMaxX: 0, bgMaxY: 0,
      rvfc: typeof v.requestVideoFrameCallback === "function",
      raf: 0, tTime: -1, gen: ++trackGenRef.current,
      onSeeked: () => { const s = trackStateRef.current; if (s) { s.recapture = true; s.bgVX = 0; s.bgVY = 0; } },
    };
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    st.canvas.width = rw; st.canvas.height = rh;
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    st.ctx = st.canvas.getContext("2d", { willReadFrequently: true });
    st.ctx.drawImage(v, 0, 0, rw, rh);
    const img = st.ctx.getImageData(0, 0, rw, rh);
    refreshGrid(img, st);
    st.gridRW = rw; st.gridRH = rh;
    st.bgMaxX = rw * TRACK_BG_CLAMP; st.bgMaxY = rh * TRACK_BG_CLAMP;
    trackStateRef.current = st;
    trackingRef.current = true;
    const cz = Math.max(1, zoom);
    const pan0 = { x: st.offX, y: st.offY };
    trackViewRef.current = { tracking: true, zoom: cz, pan: pan0, transform: `translate(${pan0.x}px, ${pan0.y}px) rotate(${rot}deg) scale(${cz})` };
    v.style.transformOrigin = "50% 50%";
    v.style.transform = trackViewRef.current.transform;
    v.addEventListener("seeked", st.onSeeked);
    trackArmedRef.current = false;
    setTrackArmed(false);
    setTrackLost(false);
    setTrackHover(false);
    setTrackBg(true);
    setZoom(cz);
    setPan(pan0);
    setOrigin("50% 50%");
    setTracking(true);
    st.step = () => {
      if (trackGenRef.current !== st.gen || !trackingRef.current) return;
      if (st.rvfc) { v.requestVideoFrameCallback(st.step); trackingTick(); }
      else { st.raf = requestAnimationFrame(st.step); trackingTick(); }
    };
    st.step();
    return true;
  };
  const recenterView = () => {
    const st = trackStateRef.current;
    const tracking = !!st && trackingRef.current;
    const v = videoRef.current;
    const rot = rotateRef.current;
    const z = tracking ? trackViewRef.current.zoom : zoom;
    if (tracking) {
      st.bgX = 0; st.bgY = 0; st.bgVX = 0; st.bgVY = 0;
      st.offX = 0; st.offY = 0;
      if (st.mode !== "bg") {
        const rect = containerRef.current && containerRef.current.getBoundingClientRect();
        const base = rect ? computeCenterPan(st, z, rect, rot) : { x: 0, y: 0 };
        st.offX = -base.x; st.offY = -base.y;
      }
    }
    const pan = { x: 0, y: 0 };
    if (tracking) {
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${z})`;
    }
    if (v) v.style.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${z})`;
    setZoom(z);
    setPan(pan);
    setOrigin("50% 50%");
  };
  const startPointCenterTracking = () => {
    const el = containerRef.current;
    const r = el && el.getBoundingClientRect();
    if (!r) return false;
    return startTracking(r.left + r.width / 2, r.top + r.height / 2);
  };
  const applyTrackPref = () => {
    const st = trackStateRef.current;
    if (st && trackingRef.current) return;
    const el = videoRef.current;
    if (!el || el.tagName !== "VIDEO" || showImageRef.current) return;
    const p = trackPrefRef.current;
    if (p === "bg") startBgTracking();
    else if (p === "point") startPointCenterTracking();
  };
  const cycleTracking = () => {
    const st = trackStateRef.current;
    if (!st) { setTrackPref("bg"); if (startBgRef.current) startBgRef.current(); return; }
    if (st.mode === "bg") { setTrackPref("point"); startPointCenterTracking(); return; }
    setTrackPref("none");
    stopTracking();
  };
  const trackingTick = () => {
    const st = trackStateRef.current;
    if (!st || !trackingRef.current || st.gen !== trackGenRef.current) return;
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO") { stopTracking(); return; }
    if (!st.rvfc && v.currentTime === st.tTime) return;
    st.tTime = v.currentTime;
    const rect = containerRef.current && containerRef.current.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return;
    const rot = rotateRef.current;
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    if (st.canvas.width !== rw || st.canvas.height !== rh) { st.canvas.width = rw; st.canvas.height = rh; }
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    const ctx = st.ctx;
    ctx.drawImage(v, 0, 0, rw, rh);
    const img = ctx.getImageData(0, 0, rw, rh);
    // Keep the view from ever sitting far outside the frame. In bg mode the
    // compensation itself is allowed to run out to TRACK_BG_CLAMP of the frame
    // and then just stops there, so the picture can sit half a frame off with
    // nothing pulling it back; here the visible drift is measured every tick and
    // eased back, firmly once it is past a small band. The pull is applied
    // through offX/offY so the compensation and the tracked point keep working
    // untouched. Paused while the user drags, and skipped when auto-center is off.
    if (autoCenterRef.current && !dragRef.current.dragging) {
      const now = performance.now();
      const dt = st.acT ? Math.min(0.25, (now - st.acT) / 1000) : 0;
      st.acT = now;
      if (dt > 0) {
        const z = trackViewRef.current.zoom;
        // tX/tY is the offX/offY that puts the view back on its reference, and
        // (offX - tX) is the drift you can see. In bg mode the reference is the
        // stabilized view; in subject mode it is the video's own center, since
        // offX is exactly the dot's on-screen offset there and easing it to 0
        // would re-center the dot instead of the video.
        let tX = 0, tY = 0;
        if (st.mode !== "bg") {
          const base = computeCenterPan(st, z, rect, rot);
          tX = (st.offX || 0) - base.x;
          tY = (st.offY || 0) - base.y;
        }
        const short = rect ? Math.min(rect.width, rect.height) : 357;
        const reach = Math.max(8, short * TRACK_AUTOCENTER_REACH);
        const fullAt = Math.max(reach + 1, short * TRACK_AUTOCENTER_MAXDRIFT);
        const vMin = short * TRACK_AUTOCENTER_PULL;
        const vMax = short * TRACK_AUTOCENTER_MAX;
        // One line, no tiers: up to TRACK_AUTOCENTER_REACH out the pull is
        // quadratic, so the view is left to roam and the stabilization stays
        // visible. Past that it comes in at TRACK_AUTOCENTER_PULL, and the pull
        // speed keeps climbing the further out the view drifts until it is
        // TRACK_AUTOCENTER_MAX by TRACK_AUTOCENTER_MAXDRIFT out.
        const pull = (off, t) => {
          const d = t - off, a = Math.abs(d);
          const f = Math.sin((Math.PI / 2) * Math.min(a / reach, 1));
          const sp = (vMin + (vMax - vMin) * Math.min(a / fullAt, 1)) * dt;
          return off + Math.sign(d) * Math.min(sp, f * a);
        };
        st.offX = pull(st.offX || 0, tX);
        st.offY = pull(st.offY || 0, tY);
        if (Math.abs(st.offX - tX) < TRACK_AUTOCENTER_EPS) st.offX = tX;
        if (Math.abs(st.offY - tY) < TRACK_AUTOCENTER_EPS) st.offY = tY;
      }
    }
    if (st.mode === "bg") {
      if (st.recapture) {
        st.recapture = false;
        refreshGrid(img, st);
        st.gridRW = st.rw; st.gridRH = st.rh;
        st.bgVX = 0; st.bgVY = 0; st.bgX = 0; st.bgY = 0; st.warm = 3;
      }
      if (st.gridRW !== st.rw || st.gridRH !== st.rh) {
        refreshGrid(img, st);
        st.gridRW = st.rw; st.gridRH = st.rh;
        st.bgVX = 0; st.bgVY = 0; st.warm = 3;
      }
      if (st.frames % 90 === 0) refreshGrid(img, st);
      if (st.warm > 0) { st.warm--; refreshGrid(img, st); st.frames++; return; }
      const gdx = [], gdy = [];
      for (const g of st.grid) {
        const px = g.fx + (g.vx || 0), py = g.fy + (g.vy || 0);
        const gr = bestTemplateSearch(img, { rw: st.rw, rh: st.rh, tpl: g.tpl, tplW: g.tplW, tplH: g.tplH, lum: st.lum }, px, py, false, 28, 60);
        if (gr.score / (g.tplW * g.tplH) < 3600) {
          const ddx = gr.x - g.fx, ddy = gr.y - g.fy;
          if (Math.hypot(ddx, ddy) < TRACK_JUMP) {
            const np = capturePatch(img, st.rw, st.rh, gr.x, gr.y, 32);
            g.tpl = np.tpl; g.tplW = np.tplW; g.tplH = np.tplH;
            g.vx = ddx; g.vy = ddy;
            g.fx = gr.x; g.fy = gr.y;
            gdx.push(ddx); gdy.push(ddy);
          }
        }
      }
      st.frames++;
      if (gdx.length >= 3) {
        gdx.sort((a, b) => a - b); gdy.sort((a, b) => a - b);
        const medDx = medOf(gdx), medDy = medOf(gdy);
        const gd = Math.hypot(medDx, medDy);
        let cx = 0, cy = 0;
        if (gd > TRACK_BG_DEAD) {
          const kk = (gd - TRACK_BG_DEAD) / gd;
          cx = -medDx * kk; cy = -medDy * kk;
        }
        st.bgVX = st.bgVX * 0.6 + cx * 0.4;
        st.bgVY = st.bgVY * 0.6 + cy * 0.4;
        st.bgX += st.bgVX - st.bgX * TRACK_BG_LEAK;
        st.bgY += st.bgVY - st.bgY * TRACK_BG_LEAK;
        st.bgX = clamp(st.bgX, -st.bgMaxX, st.bgMaxX);
        st.bgY = clamp(st.bgY, -st.bgMaxY, st.bgMaxY);
        if (st.lost) { st.lost = false; setTrackLost(false); }
        st.misses = 0;
      } else {
        st.misses++;
        st.bgVX *= 0.9; st.bgVY *= 0.9;
        if (!st.lost && st.misses >= TRACK_BG_MISS) { st.lost = true; st.bgVX = 0; st.bgVY = 0; setTrackLost(true); }
      }
      const czBg = trackViewRef.current.zoom;
      const prevBg = trackViewRef.current.pan;
      const cpc = st.cPerCanvas * czBg;
      const tBgX = st.bgX * cpc + (st.offX || 0), tBgY = st.bgY * cpc + (st.offY || 0);
      const panBg = { x: prevBg.x + (tBgX - prevBg.x) * trackSmoothRef.current, y: prevBg.y + (tBgY - prevBg.y) * trackSmoothRef.current };
      if (Math.abs(panBg.x - prevBg.x) > 0.01 || Math.abs(panBg.y - prevBg.y) > 0.01) {
        trackViewRef.current.pan = panBg;
        trackViewRef.current.transform = `translate(${panBg.x}px, ${panBg.y}px) rotate(${rot}deg) scale(${czBg})`;
        if (v.style.transform !== trackViewRef.current.transform) v.style.transform = trackViewRef.current.transform;
      }
      return;
    }
    if (st.recapture) {
      st.recapture = false;
      captureTemplate(img, st, st.fx, st.fy);
      // A seek lands on new content, so the subject is re-fingerprinted there.
      st.tplD = subjectFingerprint(img, st, st.fx, st.fy);
      refreshGrid(img, st);
      st.vx = 0; st.vy = 0;
    }
    if (st.frames % 90 === 0) refreshGrid(img, st);
    // How fast the subject is already moving decides how far it can travel
    // before the next frame. A fixed window means a fast subject is outside it
    // by the time the next frame arrives, so the match is thrown away, the
    // point stops moving and falls behind, and after ten of those it is
    // declared lost. The window follows the tracked velocity instead, and one
    // that wide is scanned with the coarse stride to stay affordable.
    const speed = Math.hypot(st.vx, st.vy);
    // While lost the window grows around where the subject was last seen plus
    // its velocity until it can reach anywhere in the frame. What keeps it from
    // locking onto the spot the click was made at, or onto whatever walks in
    // next, is the subject check below, not a narrow window: a subject that
    // leaves and comes back somewhere else has to be findable again.
    const dynRoi = st.lost
      ? Math.max(TRACK_ROI, Math.min(Math.max(st.rw, st.rh), TRACK_ROI + st.misses * TRACK_REACQ))
      : Math.max(TRACK_ROI, Math.min(TRACK_ROI_MAX, TRACK_ROI + speed * 1.5 + st.misses * 8));
    // A wider window samples further between positions, and the cost of a
    // sample is a full template comparison. Stepping over the one position that
    // actually matches is much worse than paying for the samples: a coarse
    // scan that misses the subject reports some other spot as the best match,
    // and the identity check then throws the frame away. So the sample step only
    // opens up once the window is wide enough that the cost really bites, which
    // is the lost case, where the coarse result is only a hint and the subject
    // itself is checked before anything is adopted.
    const wide = st.lost || dynRoi > 150;
    // Nothing beyond the window is considered, so the window is also what
    // bounds how far the point can be moved by a match. A separate jump limit
    // on top of that only ever threw away the subject: the further behind the
    // point had fallen, the smaller its velocity, the smaller the limit, and
    // the less chance it had of catching up again.
    // The stick term pulls the match towards where the subject was, which is
    // right while it is being followed but wrong while lost: squared distance
    // beats quality, so a good match across the frame would always lose to a
    // poor one next to the old spot and the subject could never be found again.
    const resRaw = (!st.lost || (st.frames % 2 === 0)) ? bestTemplateSearch(img, st, st.fx + st.vx * 0.5, st.fy + st.vy * 0.5, wide, dynRoi, st.lost ? 0 : null, st.lost ? 5 : 1) : null;
    // While lost the search hands back several peaks and the identity check
    // picks between them. The SSD template is neither scale nor rotation
    // invariant, so where the subject came back does not always rank first on
    // resemblance to the old picture of it, and ranking on SSD alone would hide
    // it behind a neighbour that happened to look more like it.
    let res = resRaw;
    if (Array.isArray(resRaw)) {
      res = resRaw.length ? resRaw[0] : null;
      let bestM = -1;
      for (const c of resRaw) {
        if (c.score / (st.tplW * st.tplH) >= 3600) continue;
        const m = st.tplD ? subjectSame(st, capturePatch(img, st.rw, st.rh, c.x, c.y, TRACK_ID)) : 1;
        if (m > bestM) { bestM = m; res = c; }
      }
      // None of the peaks look like the subject. Fall back to sweeping the
      // whole frame for it by identity, which does not care where it was.
      if (bestM < (st.tplD ? TRACK_REACQ_KEEP : 0)) {
        const found = st.tplD ? identitySearch(img, st) : null;
        if (found) res = { x: found.x, y: found.y, score: 0 };
      }
    }
    const resOK = res && res.score / (st.tplW * st.tplH) < 3600;
    let resDX = 0, resDY = 0, resD = Infinity;
    if (resOK) { resDX = res.x - st.fx; resDY = res.y - st.fy; resD = Math.hypot(resDX, resDY); }
    let medDx = 0, medDy = 0, gridOK = false;
    if ((!resOK || resD > dynRoi) && st.grid) {
      // The grid patches ride along with the same motion, so their window and
      // step have to grow with it too or they stop contributing exactly when
      // the frame moves fastest.
      const gRoi = Math.max(28, Math.min(160, 28 + speed * 1.5));
      const gdx = [], gdy = [];
      for (const g of st.grid) {
        const gr = bestTemplateSearch(img, { rw: st.rw, rh: st.rh, tpl: g.tpl, tplW: g.tplW, tplH: g.tplH, lum: st.lum }, g.fx, g.fy, gRoi > 90, gRoi);
        if (gr.score / (g.tplW * g.tplH) < 3600) {
          const ddx = gr.x - g.fx, ddy = gr.y - g.fy;
          if (Math.hypot(ddx, ddy) < gRoi) {
            const np = capturePatch(img, st.rw, st.rh, gr.x, gr.y, 32);
            g.tpl = np.tpl; g.tplW = np.tplW; g.tplH = np.tplH;
            g.fx += ddx * 0.5; g.fy += ddy * 0.5;
            gdx.push(ddx); gdy.push(ddy);
          }
        }
      }
      if (gdx.length >= 3) {
        gdx.sort((a, b) => a - b); gdy.sort((a, b) => a - b);
        medDx = gdx[gdx.length >> 1]; medDy = gdy[gdy.length >> 1];
        gridOK = true;
      }
    }
    // A match only counts if what is under it still looks like the subject that
    // was clicked. The template itself is re-captured freely, so a subject that
    // changes size or rotation is still followed, but a match that has drifted
    // onto the background is rejected and counted as a miss instead. What the
    // match has to clear is this check, not a distance: the window already
    // bounds how far away it can be, and it has to be allowed to be that far
    // or a subject that moved quickly can never be picked back up.
    // What has to clear this is the comparison, not a distance: the window
    // already bounds how far away a match can be, and it has to be allowed to
    // be that far or a subject that moved quickly can never be picked back up.
    // The bar is a little higher while lost, because then the candidate is a
    // patch from anywhere in the frame rather than one of a few matches near
    // where the subject was last seen.
    const cand = resOK ? capturePatch(img, st.rw, st.rh, res.x, res.y, TRACK_TPL) : null;
    const idc = cand ? capturePatch(img, st.rw, st.rh, res.x, res.y, TRACK_ID) : null;
    const onSubject = idc ? (!st.tplD || subjectSame(st, idc) >= (st.lost ? TRACK_REACQ_KEEP : TRACK_KEEP)) : false;
    if (cand && onSubject) {
      const wasLost = st.lost;
      st.lost = false; st.misses = 0;
      st.tpl = cand.tpl; st.tplW = cand.tplW; st.tplH = cand.tplH;
      if (st.tplD) subjectUpdate(st, idc);
      if (wasLost) { refreshGrid(img, st); st.vx = 0; st.vy = 0; setTrackLost(false); }
        if (resD > TRACK_DEAD) {
          const k = (resD - TRACK_DEAD) / resD;
          const f = Math.min(1, 0.3 + resD / 30);
          st.vx = st.vx * (1 - f) + resDX * k * f;
          st.vy = st.vy * (1 - f) + resDY * k * f;
          st.fx += resDX * k * f;
          st.fy += resDY * k * f;
        } else {
          st.vx *= 0.85; st.vy *= 0.85;
        }
    } else if (gridOK) {
      const gd = Math.hypot(medDx, medDy);
      if (gd > TRACK_DEAD) {
        const k = (gd - TRACK_DEAD) / gd;
        const nfx = st.fx + medDx * k * 0.3;
        const nfy = st.fy + medDy * k * 0.3;
        // The grid only measures how the neighbourhood moved, it says nothing
        // about what is there now, so a subject that walked in would drag the
        // point onto itself. Only let it move the point while the clicked
        // subject is still under the new spot.
        // The identity descriptor is sampled on its own size, so this has to
        // be a patch of that size: compare a smaller one and the two are not
        // describing the same pixels at all, and the check passes on anything.
        const probe = capturePatch(img, st.rw, st.rh, nfx, nfy, TRACK_ID);
        if (!st.tplD || subjectSame(st, probe) >= TRACK_KEEP) {
          st.fx = nfx;
          st.fy = nfy;
          st.misses = 0;
          st.vx = st.vx * 0.7 + medDx * 0.3;
          st.vy = st.vy * 0.7 + medDy * 0.3;
        } else {
          st.misses++;
          st.vx *= 0.9;
          st.vy *= 0.9;
          if (!st.lost && st.misses >= 10) { st.lost = true; setTrackLost(true); }
        }
      } else {
        st.misses = 0;
        st.vx *= 0.7;
        st.vy *= 0.7;
      }
    } else if (cand || res) {
      st.misses++;
      st.vx *= 0.9; st.vy *= 0.9;
      // The velocity is deliberately left running when the point is declared
      // lost: it is what carries the re-acquisition window along the path the
      // subject was taking, and it decays on its own while lost.
      if (!st.lost && st.misses >= 10) { st.lost = true; setTrackLost(true); }
    }
    st.frames++;
    const cz = trackViewRef.current.zoom;
    const target = computeCenterPan(st, cz, rect, rot);
    const cur = trackViewRef.current.pan;
    const pan = { x: cur.x + (target.x - cur.x) * trackSmoothRef.current, y: cur.y + (target.y - cur.y) * trackSmoothRef.current };
    const prev = trackViewRef.current.pan;
    if (Math.abs(pan.x - prev.x) > 0.01 || Math.abs(pan.y - prev.y) > 0.01) {
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${cz})`;
      if (v.style.transform !== trackViewRef.current.transform) v.style.transform = trackViewRef.current.transform;
    }
  };
  // React registers wheel listeners as passive, so preventDefault() inside
  // onWheel is ignored and the window scrolls during zoom. Drive zoom through
  // a native non-passive listener instead.
  const handleWheelRef = useRef(null);
  handleWheelRef.current = handleWheel;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = (e) => { if (handleWheelRef.current) handleWheelRef.current(e); };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);
  // The smooth box lives in the pill, which only exists while tracking, so the
  // wheel listener is (re)bound whenever tracking toggles. Native + non-passive
  // so preventDefault blocks the container's zoom handler from also firing.
  useEffect(() => {
    const el = smoothInputRef.current;
    if (!el) return;
    const onWheelSmooth = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = parseFloat(el.value);
      const base = Number.isFinite(cur) ? cur : readTrackSmoothUi();
      const next = Math.min(TRACK_SMOOTH_UI_MAX, Math.max(0, Math.round((base + (e.deltaY < 0 ? 0.5 : -0.5)) * 2) / 2));
      el.value = String(next);
      applyTrackSmoothUiRef.current(next);
    };
    el.addEventListener("wheel", onWheelSmooth, { passive: false });
    return () => el.removeEventListener("wheel", onWheelSmooth);
  }, [tracking]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => { const r = el.getBoundingClientRect(); setStageSize({ w: r.width, h: r.height }); };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const handleMouseDown = (e) => {
    if (!showImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
    if (trackingRef.current) {
      const st = trackStateRef.current;
      dragRef.current = { dragging: true, trackDrag: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, downX: e.clientX, downY: e.clientY, origOffX: st ? st.offX || 0 : 0, origOffY: st ? st.offY || 0 : 0 };
      e.preventDefault();
      return;
    }
    if (zoom === 1 || isAudio) {
      if (!showImage) e.preventDefault();
      return;
    }
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
    e.preventDefault();
  };
  const handleMouseMove = (e) => {
    if (trackingRef.current) pokeDot();
    if (!dragRef.current.dragging) return;
    if (dragRef.current.trackDrag) {
      const st = trackStateRef.current;
      if (!st || !trackingRef.current) return;
      const ddx = e.clientX - dragRef.current.lastX;
      const ddy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX; dragRef.current.lastY = e.clientY;
      st.offX = (st.offX || 0) + ddx;
      st.offY = (st.offY || 0) + ddy;
      const tv = trackViewRef.current;
      tv.pan = { x: tv.pan.x + ddx, y: tv.pan.y + ddy };
      const rot = rotateRef.current;
      tv.transform = `translate(${tv.pan.x}px, ${tv.pan.y}px) rotate(${rot}deg) scale(${tv.zoom})`;
      const v = videoRef.current;
      if (v) v.style.transform = tv.transform;
      setPan({ x: tv.pan.x, y: tv.pan.y });
      return;
    }
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  };
  const handleMouseUp = () => {
    const wasDragging = dragRef.current.dragging;
    dragRef.current.dragging = false;
    if (wasPlayingRef.current && videoRef.current && !showImage) {
      const v = videoRef.current;
      wasPlayingRef.current = false;
      v.play().catch(() => {});
    } else if (!wasDragging) {
      wasPlayingRef.current = false;
    }
  };
  const touchRef = useRef({ startX: 0, startY: 0, startTime: 0, isSeeking: false, isHorizontal: null, startPan: { x: 0, y: 0 } });
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { startX: t.clientX, startY: t.clientY, startTime: videoRef.current?.currentTime || 0, isSeeking: false, isHorizontal: null, startPan: { ...pan }, lastDx: 0, pinchActive: false, wasMultiTouch: false };
    if (e.touches.length > 1) {
      touchRef.current.wasMultiTouch = true;
      if (!showImage && wasPlayingRef.current && videoRef.current) {
        wasPlayingRef.current = false;
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    if (!showImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
  };
  const handleTouchMove = (e) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touchRef.current.startX;
    const dy = t.clientY - touchRef.current.startY;
    if (e.touches.length >= 2) {
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      const pr = touchRef.current;
      if (!pr.pinchActive) {
        pr.pinchActive = true;
        pr.pinchPrevDist = dist;
        pr.pinchPrevZoom = zoom;
        pr.pinchPrevPan = { ...pan };
        pr.pinchPrevMid = { x: midX, y: midY };
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const newZoom = Math.min(4, Math.max(1, pr.pinchPrevZoom * (dist / pr.pinchPrevDist)));
        let nextPan = { x: 0, y: 0 };
        if (newZoom === 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
          setOrigin("50% 50%");
        } else {
          const ratio = newZoom / pr.pinchPrevZoom;
          const ax = pr.pinchPrevMid.x - cx;
          const ay = pr.pinchPrevMid.y - cy;
          nextPan = {
            x: (midX - cx) - (ax - pr.pinchPrevPan.x) * ratio,
            y: (midY - cy) - (ay - pr.pinchPrevPan.y) * ratio,
          };
          setZoom(newZoom);
          setPan(nextPan);
          setOrigin("50% 50%");
        }
        pr.pinchPrevZoom = newZoom;
        pr.pinchPrevPan = nextPan;
        pr.pinchPrevMid = { x: midX, y: midY };
        pr.pinchPrevDist = dist;
      }
      return;
    }
    if (zoom > 1) {
      setPan({ x: touchRef.current.startPan.x + dx, y: touchRef.current.startPan.y + dy });
      e.preventDefault();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8 && videoRef.current) {
      if (seekFrames) {
        // per-frame: 8px = 1 frame, step one frame at a time without skipping
        const frames = Math.trunc(dx / 8);
        const lastFrames = Math.trunc((touchRef.current.lastDx || 0) / 8);
        const deltaFrames = frames - lastFrames;
        if (deltaFrames !== 0) {
          const nt = Math.max(0, Math.min(duration || 1e9, videoRef.current.currentTime + deltaFrames * (1/30)));
          videoRef.current.currentTime = nt;
          setCurrent(nt);
          touchRef.current.lastDx = dx - (dx % 8);
        }
      } else {
        const delta = dx * 0.06;
        const nt = Math.max(0, Math.min(duration || 1e9, touchRef.current.startTime + delta));
        videoRef.current.currentTime = nt;
        setCurrent(nt);
      }
      e.preventDefault();
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) e.preventDefault();
  };
  const handleTouchEnd = (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    const pr = touchRef.current;
    const dx = t.clientX - pr.startX;
    const dy = t.clientY - pr.startY;
    const isRandom = endModeRef.current === "random";
    const wasNav = zoom === 1 && !pr.wasMultiTouch && Math.abs(dy) > 25 && Math.abs(dy) > Math.abs(dx) && (isRandom ? total > 1 : ((dy < 0 && hasNext) || (dy > 0 && hasPrev)));
    if (wasNav) {
      wasPlayingRef.current = false;
      if (dy < 0) dispatchNextRef.current();
      else if (dy > 0) dispatchPrevRef.current();
      return;
    }
    if (pr.wasMultiTouch && e.touches && e.touches.length === 1) {
      const r = e.touches[0];
      pr.startX = r.clientX;
      pr.startY = r.clientY;
      pr.startTime = videoRef.current?.currentTime || 0;
      pr.startPan = { ...pan };
      pr.lastDx = 0;
    }
    if (wasPlayingRef.current && videoRef.current && !showImage) {
      const v = videoRef.current;
      wasPlayingRef.current = false;
      v.play().catch(() => {});
    } else {
      wasPlayingRef.current = false;
    }
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      const k = e.key;
      const isLeft = k === "ArrowLeft" || k === "a" || k === "A";
      const isRight = k === "ArrowRight" || k === "d" || k === "D";
      const isUp = k === "ArrowUp" || k === "w" || k === "W";
      const isDown = k === "ArrowDown" || k === "s" || k === "S";
      if ((k === "/" || k === "?") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); setShowHelp((v) => !v); return;
      }
      if (k === "Escape") {
        if (showPlaylistRef.current) { e.preventDefault(); setShowPlaylist(false); return; }
        if (showHelp) { e.preventDefault(); setShowHelp(false); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); e.preventDefault(); return; }
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "q" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setSeekFrames((v) => !v); }
      } else if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Always swallow Space while the viewer is open so the window never scrolls.
        e.preventDefault();
        if ((!showImage) && videoRef.current) {
          if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; jogWasPlayingRef.current = false; videoRef.current.pause(); }
          else { if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); }
        }
       } else if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setMuted((v) => !v); }
      } else if (e.key.toLowerCase() === "r" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); cycleEndModeRef.current(); }
      } else if (e.key.toLowerCase() === "r" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); rotateFile(); }
      } else if (e.key.toLowerCase() === "t" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tv = videoRef.current;
        if (tv && tv.tagName === "VIDEO" && !showImageRef.current && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) {
          e.preventDefault();
          if (cycleTrackRef.current) cycleTrackRef.current();
        }
      } else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tv = videoRef.current;
        if (tv && tv.tagName === "VIDEO" && !showImageRef.current && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) {
          e.preventDefault();
          // Short press recenters on keyup; holding toggles stabilization.
          if (!e.repeat) beginHold(tHoldRef, () => { if (autoCenterToggleRef.current) autoCenterToggleRef.current(); });
        }
      } else if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(-0.1); }
      } else if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(0.1); }
      } else if ((e.key === "<" || (e.key === "," && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(-0.1);
      } else if ((e.key === ">" || (e.key === "." && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(0.1);
      } else if (isLeft) {
        if (showImage) { e.preventDefault(); dispatchPrevRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            seekTo(Math.max(0, v.currentTime - 5));
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              seekTo(Math.max(0, v.currentTime - 1/30)); steps++;
            }, 33 / rate);
          } else { seekTo(Math.max(0, v.currentTime - 1)); }
        }
      } else if (isRight) {
        if (showImage) { e.preventDefault(); dispatchNextRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 5));
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 1/30)); steps++;
            }, 33 / rate);
          } else { seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 1)); }
        }
      } else if (isUp) { if (endModeRef.current === "random" || hasPrev) { e.preventDefault(); dispatchPrevRef.current(); } }
      else if (isDown) { if (endModeRef.current === "random" || hasNext) { e.preventDefault(); dispatchNextRef.current(); } }
      else if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.repeat) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastYRef.current < 600) {
          lastYRef.current = 0;
          setYConfirm(false);
          if (yConfirmTimerRef.current) { clearTimeout(yConfirmTimerRef.current); yConfirmTimerRef.current = null; }
          if (doDeleteFileRef.current) doDeleteFileRef.current();
        } else {
          lastYRef.current = now;
          setYConfirm(true);
          if (yConfirmTimerRef.current) clearTimeout(yConfirmTimerRef.current);
          yConfirmTimerRef.current = setTimeout(() => { setYConfirm(false); lastYRef.current = 0; yConfirmTimerRef.current = null; }, 600);
        }
      }
    };
    // Keyup finishes the T gesture: a hold already toggled stabilization, a
    // short press recenters on the spot. Losing focus mid-hold cancels it so a
    // gesture can never get stuck on.
    const onKeyUp = (e) => {
      if (e.key.toLowerCase() !== "t") return;
      const tv = videoRef.current;
      if (!(tv && tv.tagName === "VIDEO") || showImageRef.current) return;
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      clearHold(tHoldRef);
      if (heldRecently(tHoldRef)) return;
      if (e.shiftKey) return;
      if (recenterRef.current) recenterRef.current();
    };
    const onBlur = () => { clearHold(tHoldRef); clearHold(holdRef); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", onBlur); document.body.style.overflow = prev; };
  }, [onClose, hasPrev, hasNext, onPrev, onNext, showImage, duration, seekFrames, rate, showHelp, seekTo]);
  // Hold-F: keep the save popup open while F is held; letter toggles the
  // first matching list, 1-9 toggles extras by number.
  // The F fullscreen keybind is disabled (button still available).
  useEffect(() => {
    const isEditable = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKeyDown = (e) => {
      if (isEditable(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === "f" || k === "F") {
        if (e.repeat) { e.preventDefault(); return; }
        e.preventDefault();
        e.stopPropagation();
        fHeldRef.current = true;
        setFHeld(true);
        return;
      }
      if (fHeldRef.current && /^[1-9]$/.test(k)) {
        // Digits toggle extras (lists without a letter hotkey: shared first
        // letter beyond the first, or non-letter names), numbered 1-9.
        const extras = fvPlaylists.filter((p, i) => {
          const ch = String(p.name || "").trim().charAt(0).toLowerCase();
          return !(/^[a-z]$/.test(ch) && fvPlaylists.findIndex((q) => String(q.name || "").trim().charAt(0).toLowerCase() === ch) === i);
        });
        const hit = extras[parseInt(k, 10) - 1];
        if (hit && filePathEff) {
          e.preventDefault();
          e.stopPropagation();
          fvToggleItem(hit.id, filePathEff).catch(() => {});
        }
        return;
      }
      if (fHeldRef.current && /^[a-zA-Z]$/.test(k)) {
        // Letter hotkey: toggles the first list starting with that letter
        // (F+O → "orange"). Later lists sharing the letter use 1-9.
        const hit = fvPlaylists.find((p) => String(p.name || "").trim().charAt(0).toLowerCase() === k.toLowerCase());
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          if (filePathEff) fvToggleItem(hit.id, filePathEff).catch(() => {});
          return;
        }
        // No list starts with this letter — fall through to normal keys.
      }
    };
    const onKeyUp = (e) => {
      const k = e.key;
      if (k === "f" || k === "F") {
        if (fHeldRef.current) {
          fHeldRef.current = false;
          setFHeld(false);
        }
      }
    };
    const onBlur = () => {
      if (fHeldRef.current) {
        fHeldRef.current = false;
        setFHeld(false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fvPlaylists, filePathEff]);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    try { history.pushState({ viewer: true }, ""); } catch {}
    const onPop = () => onCloseRef.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      try { if (history.state && history.state.viewer) history.back(); } catch {}
    };
  }, []);
  useEffect(() => {
    const finePointer = !(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    const onShiftDown = (e) => {
      if (e.key !== "Shift" || e.repeat) return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (finePointer && videoishRef.current && !showImageRef.current && videoRef.current && videoRef.current.tagName === "VIDEO") {
        trackArmedRef.current = true;
        setTrackArmed(true);
      }
      if (showImageRef.current || !videoRef.current || videoRef.current.paused) return;
      if (shiftWasPlayingRef.current) return;
      shiftWasPlayingRef.current = true;
      videoRef.current.pause();
    };
    const onShiftUp = (e) => {
      if (e.key !== "Shift") return;
      trackArmedRef.current = false;
      setTrackArmed(false);
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) { shiftWasPlayingRef.current = false; return; }
      if (!shiftWasPlayingRef.current || !videoRef.current || showImageRef.current) { shiftWasPlayingRef.current = false; return; }
      shiftWasPlayingRef.current = false;
      videoRef.current.play().catch(() => {});
    };
    const stopJog = () => {
      if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
      if (jogWasPlayingRef.current && videoRef.current) { jogWasPlayingRef.current = false; videoRef.current.play().catch(() => {}); }
    };
    const onBlur = () => { shiftWasPlayingRef.current = false; stopJog(); trackArmedRef.current = false; setTrackArmed(false); };
    window.addEventListener("keydown", onShiftDown);
    window.addEventListener("keyup", onShiftUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onShiftDown);
      window.removeEventListener("keyup", onShiftUp);
      window.removeEventListener("blur", onBlur);
      stopJog();
    };
  }, [showImage]);
  useEffect(() => () => { trackGenRef.current++; trackingRef.current = false; if (dotTimerRef.current) clearTimeout(dotTimerRef.current); }, []);

  const doDeleteFile = async () => {
    const { folder, base } = parseFolderBase(filePathEff);
    if (!base) return;
    if (deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "delete failed");
      saveFileRotation(filePathEff, 0);
      // Parent owns viewer position (key-based, plan 014): it moves to the
      // neighbour (next ?? prev) and reloads without jumping to the top.
      // Fall back to local navigation only when no parent handler is wired.
      if (onDeleted) onDeleted(filePathEff);
      else if (total <= 1) onClose();
      else if (!hasNext && hasPrev) onPrev();
    } catch (e) { setAlertState({ open: true, title: "Delete failed", message: e.message }); }
    finally { setDeleting(false); }
  };
  const handleDelete = () => {
    const { base } = parseFolderBase(filePathEff);
    if (!base) return;
    setConfirmOpen(true);
  };
  const handleConfirmDelete = async () => {
    setConfirmOpen(false);
    await doDeleteFile();
  };
  doDeleteFileRef.current = doDeleteFile;
  startBgRef.current = startBgTracking;
  cycleTrackRef.current = cycleTracking;
  autoCenterToggleRef.current = toggleAutoCenter;
  recenterRef.current = recenterView;
  applyTrackPrefRef.current = applyTrackPref;

  return (
    <>
    <div
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", inset: 0, zIndex: 110, display: "flex", alignItems: "stretch", justifyContent: "stretch", padding: 0, margin: 0, background: "rgba(6,8,18,0.72)", backdropFilter: "blur(8px)" }}
    >
      <div
        ref={viewerRef}
        onClick={(e) => e.stopPropagation()}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--surface)", border: "none", borderRadius: 0, overflow: "hidden", boxShadow: "none", margin: 0, boxSizing: "border-box", position: "relative" }}
      >
        <div className="fv-header" style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 5, display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: "transparent", border: "none", pointerEvents: "none" }}>
          <div className="fv-nav" style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto", position: "relative" }}>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchNextRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasNext} title="Next (↓)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-down" /></button>
            <span className="badge" style={{ fontFamily: "var(--mono)", fontSize: 11, minWidth: 54, justifyContent: "center", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", color: "#fff", backdropFilter: "blur(6px)" }}>{endMode === "random" && randHistory.length > 1 ? `${randCursor + 1}/${randHistory.length} · ` : ""}{idx + 1} / {total}</span>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchPrevRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasPrev} title="Previous (↑)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-up" /></button>
            {(() => {
              const { base } = parseFolderBase(filePathEff);
              const label = base || titleEff;
              if (!label) return null;
              return (
                <span data-testid="viewer-filename" className="fv-filename" title={label} style={{ position: "absolute", left: "calc(100% + 8px)", top: "50%", transform: "translateY(-50%)", fontSize: 12, fontWeight: 500, color: "#fff", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", backdropFilter: "blur(6px)", padding: "6px 10px", borderRadius: 999, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              );
            })()}
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, pointerEvents: "auto" }}>
            {yConfirm && <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: "#ef4444", padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,.2)", whiteSpace: "nowrap", alignSelf: "center" }}>Press p again to confirm delete</span>}
            <button type="button" tabIndex={-1} onClick={handleDelete} disabled={deleting} className="btn btn-sm" aria-label="Delete file" title={yConfirm ? "Press p again to confirm — or click to delete" : "Delete file (press p twice)"} style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: yConfirm ? "1px solid #ef4444" : "1px solid rgba(255,255,255,.18)", background: yConfirm ? "#ef4444" : "rgba(0,0,0,.55)", color: yConfirm ? "#fff" : "#ff8080", backdropFilter: "blur(6px)", animation: yConfirm ? "pulse 0.6s ease infinite" : "none" }}><i className="bi bi-trash" /></button>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" tabIndex={-1} onClick={onClose} className="btn btn-sm" aria-label="Close" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-x-lg" /></button>
              <div
                ref={playlistHoverRef}
                onMouseEnter={() => { if (playlistCloseTimer.current) { clearTimeout(playlistCloseTimer.current); playlistCloseTimer.current = null; } try { if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return; } catch {} setShowPlaylist(true); }}
                onMouseLeave={() => { if (playlistCloseTimer.current) clearTimeout(playlistCloseTimer.current); playlistCloseTimer.current = setTimeout(() => setShowPlaylist(false), 120); }}
                style={{ position: "relative" }}
              >
                {(() => {
                  const vBookmarked = !!filePathEff && fvPlaylists.some((pl) => (pl.items || []).includes(filePathEff));
                  const vOpen = showPlaylist || fHeld;
                  return (
                    <>
                      <button
                        type="button"
                        tabIndex={-1}
                        data-testid="viewer-playlist-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          // coarse pointer (mobile) fallback to tap toggle
                          try { if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) setShowPlaylist((v) => !v); } catch { setShowPlaylist((v) => !v); }
                        }}
                        aria-label="Add to playlist"
                        title="Add to playlist"
                        style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: vOpen ? "rgba(99,102,241,.9)" : vBookmarked ? "rgba(99,102,241,.85)" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}
                      >
                        <i className={`bi ${vBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} />
                      </button>
                      {vOpen && (
                        <div style={{ position: "absolute", top: 44, right: 0, zIndex: 95 }} onClick={(e) => e.stopPropagation()}>
                          <PlaylistHoverMenu mediaKey={filePathEff} showIndex={fHeld} />
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>

        <style>{`.fv-nav .fv-filename{opacity:0;transition:opacity .15s} .fv-nav:hover .fv-filename{opacity:1} @keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.08)}100%{transform:scale(1)}} video::-webkit-media-controls-panel,video::-webkit-media-controls-enclosure{ background: transparent !important; background-image: none !important; box-shadow: none !important; } video::-webkit-media-controls-timeline{ background: transparent !important; }
@media (max-width: 640px){
  .fv-header{ padding: 6px 8px !important; gap: 4px !important; }
  .fv-header .btn{ padding: 3px 6px !important; font-size: 10px !important; }
  .fv-controls{ padding: 6px 8px !important; gap: 4px !important; }
  .fv-timeline{ gap: 4px !important; }
  .fv-timeline span{ font-size: 10px !important; min-width: 28px !important; }
  .fv-speed{ gap: 4px !important; }
  .fv-speed input[type="range"]{ width: 70px !important; height: 3px !important; }
  .fv-controls .btn{ padding: 3px 6px !important; font-size: 10px !important; }
  .fv-timeline input[type="range"]{ height: 3px !important; }
}
@media (max-width: 480px){
  .fv-header{ flex-wrap: nowrap !important; padding: 6px 8px !important; }
  .fv-header > div:nth-child(2){ display: none !important; }
}`}</style>
        <div ref={containerRef} onClick={handleStageClick} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} style={{ position: "relative", flex: "1 1 auto", minHeight: 0, overflow: "hidden", background: "#080a14", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, cursor: trackArmed ? "crosshair" : tracking ? "grab" : "default", touchAction: "none" }}>
          {zoom>1 && <span style={{ position: "absolute", top: 10, right: 10, zIndex: 3, background: "rgba(0,0,0,.6)", color: "#fff", padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)" }}>{Math.round(zoom*100)}%</span>}
          {(loading || (!mediaReady && isFormatKnown)) && (
            <span data-testid="viewer-loading" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", zIndex: 2 }}>
              <span className="xdl-thumb-spinner" />
            </span>
          )}
          {loading ? null : showImage ? (
            <img key={loadedUrl} ref={imgRef} src={loadedUrl} alt={titleEff} onContextMenu={(e) => e.preventDefault()} draggable={false} onLoad={() => setMediaReady(true)} onError={isGif ? () => setGifAsVideo(true) : () => setMediaReady(true)} style={{ width: mediaW, height: mediaH, objectFit: "contain", background: "#000", borderRadius: 0, opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }} />
          ) : gifAsVideoEff ? (
            <video
              key={loadedUrl}
              ref={videoRef}
              src={loadedUrl}
              autoPlay
              playsInline
              preload="metadata"
              tabIndex={0}
              autoFocus
              onClick={(e)=> { e.stopPropagation(); handleStageClick(e); }}
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: trackArmed ? "crosshair" : "default", outline: "none" }}
              onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)}
              onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)}
              onLoadedData={() => setMediaReady(true)}
              onCanPlay={() => setMediaReady(true)}
              onError={() => setMediaReady(true)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          ) : isAudio ? (
            <div style={{ width: "100%", padding: 24, display: "grid", placeItems: "center", opacity: mediaReady ? 1 : 0, transition: "opacity .45s ease" }}>
              <audio key={loadedUrl} ref={videoRef} src={loadedUrl} autoPlay style={{ width: "100%", display: "none" }} onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)} onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)} onLoadedData={() => setMediaReady(true)} onCanPlay={() => setMediaReady(true)} onError={() => setMediaReady(true)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
              <div style={{ width: "100%", textAlign: "center", color: "var(--muted)", fontSize: 13 }}><i className="bi bi-music-note-beamed" style={{ fontSize: 32, display: "block", marginBottom: 8 }} /> Audio playback — use controls below</div>
            </div>
          ) : isFormatKnown ? (
            <video
              key={loadedUrl}
              ref={videoRef}
              src={loadedUrl}
              autoPlay
              playsInline
              preload="metadata"
              tabIndex={0}
              autoFocus
              onClick={(e)=> { e.stopPropagation(); handleStageClick(e); }}
              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: trackArmed ? "crosshair" : "default", outline: "none" }}
              onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)}
              onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)}
              onLoadedData={() => setMediaReady(true)}
              onCanPlay={() => setMediaReady(true)}
              onError={() => setMediaReady(true)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          ) : (
            <div style={{ width: "100%", padding: 24, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 13 }}>
              <div style={{ textAlign: "center" }}>
                <i className="bi bi-file-earmark-x" style={{ fontSize: 32, display: "block", marginBottom: 8 }} />
                Cannot preview <span style={{ fontFamily: "var(--mono)" }}>{ext ? ext : "unknown"}</span> in the browser.
                <div style={{ marginTop: 12 }}>
                  <a href={loadedUrl} target="_blank" rel="noopener noreferrer" download className="btn btn-sm btn-outline-secondary"><i className="bi bi-download" /> Open / download original</a>
                </div>
              </div>
            </div>
          )}
          {tracking && (
            <>
            <span onClick={(e) => { e.stopPropagation(); const d = dragRef.current; if (d && d.downX !== undefined && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) > 6) return; setTrackPref("none"); stopTracking(); }} onMouseEnter={() => { setTrackHover(true); if (dotTimerRef.current) clearTimeout(dotTimerRef.current); }} onMouseLeave={() => { setTrackHover(false); pokeDot(); }} style={{ position: "absolute", left: `calc(50% + ${((trackStateRef.current && trackStateRef.current.offX) || 0)}px)`, top: `calc(50% + ${((trackStateRef.current && trackStateRef.current.offY) || 0)}px)`, width: 22, height: 22, transform: "translate(-50%,-50%)", border: `1.5px solid rgba(${trackLost ? "248,113,113" : "129,140,248"},${trackHover ? ".95" : ".35"})`, borderRadius: "50%", boxShadow: `0 0 0 3px rgba(0,0,0,${trackHover ? ".5" : ".2"})`, zIndex: 3, pointerEvents: dotVisible ? "auto" : "none", cursor: "pointer", opacity: (dotVisible || trackHover) ? 1 : 0, transition: "opacity .25s", display: trackBg ? "none" : "block" }}>
              <span style={{ position: "absolute", left: "50%", top: "50%", width: 5, height: 5, transform: "translate(-50%,-50%)", borderRadius: "50%", background: `rgba(${trackLost ? "248,113,113" : "129,140,248"},${trackHover ? ".95" : ".45"})` }} />
            </span>
            <div onTouchStart={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} onTouchCancel={(e) => e.stopPropagation()} style={{ position: "absolute", right: 12, bottom: 12, zIndex: 4, display: "flex", alignItems: "center", gap: 6, maxWidth: "calc(100% - 24px)", pointerEvents: "none" }}>
              <div style={{ flex: "0 1 auto", minWidth: 0, background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", fontSize: 11, padding: "5px 10px", borderRadius: 999, pointerEvents: "none", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", backdropFilter: "blur(2px)" }}>{trackLost ? (trackBg ? "Background motion lost — camera view will drift" : "Tracking lost — move subject back into view") : ((trackStateRef.current && trackStateRef.current.tex < TRACK_TEX_MIN && !trackBg) ? "Low-detail spot — pick a busier area" : "tracking smoothness")} <input type="number" ref={smoothInputRef} min={0} max={10} step={0.5} defaultValue={readTrackSmoothUi()} title="Scroll to adjust" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()} onChange={(e) => { const s = parseFloat(e.target.value); if (!Number.isFinite(s)) return; applyTrackSmoothUiRef.current(s); }} style={{ width: 44, fontSize: 11, background: "rgba(255,255,255,.12)", border: "1px solid rgba(255,255,255,.25)", borderRadius: 6, color: "#fff", textAlign: "center", padding: "1px 4px", pointerEvents: "auto", outline: "none" }} /></div>
              <button
                type="button"
                tabIndex={-1}
                className={`btn btn-sm ${autoCenter ? "btn-primary" : "btn-outline-secondary"}`}
                title={autoCenter ? "Recenter view (T) — auto-center on, hold to turn off" : "Recenter view (T) — auto-center off, hold to turn on"}
                style={{ flex: "0 0 auto", width: 30, height: 30, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: autoCenter ? "#6366f1" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)", pointerEvents: "auto", touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
                onPointerDown={(e) => { e.stopPropagation(); clearHoldTimer(); holdRef.current.fired = false; holdRef.current.timer = setTimeout(() => { holdRef.current.timer = null; holdRef.current.fired = true; toggleAutoCenter(); }, TRACK_HOLD_MS); }}
                onPointerUp={(e) => { e.stopPropagation(); clearHoldTimer(); }}
                onPointerCancel={() => clearHoldTimer()}
                onPointerLeave={() => clearHoldTimer()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (holdRef.current.fired) { holdRef.current.fired = false; return; } recenterView(); }}
              ><i className="bi bi-bullseye" /></button>
            </div>
            </>
          )}
          {trackMiss && (
            <div style={{ position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)", zIndex: 4, background: "rgba(0,0,0,.6)", border: "1px solid rgba(251,191,36,.5)", color: "#fde68a", fontSize: 11, padding: "5px 10px", borderRadius: 999, pointerEvents: "none", whiteSpace: "nowrap" }}>Click inside the video — not the black bars</div>
          )}
        </div>

        <div className="fv-controls" style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", background: "var(--surface)", display: "grid", gap: 6 }}>
            {(isVideo || isAudio || gifAsVideoEff) && (
            <div className="fv-timeline" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(current)}</span>
              <input ref={seekRef} type="range" tabIndex={-1} min={0} max={duration || 0} step="any" defaultValue={0} onChange={(e)=> { const v=parseFloat(e.target.value); if(!videoRef.current) return; if (isDraggingRef.current) { animRef.current = null; pendingSeekRef.current = null; videoRef.current.currentTime = v; setCurrent(v); } else { seekTo(v); } }} onPointerDown={(e)=>{ pressedRef.current = true; isDraggingRef.current = false; pressStartRef.current = { x: e.clientX, y: e.clientY }; }} onPointerMove={(e)=>{ if (pressedRef.current) { const dx = e.clientX - pressStartRef.current.x; const dy = e.clientY - pressStartRef.current.y; if (Math.hypot(dx, dy) > 4) isDraggingRef.current = true; } }} onPointerUp={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} onPointerCancel={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} onBlur={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} style={{ flex: 1, accentColor: "#6366f1", height: 4 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(duration)}</span>
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={toggleFullscreen} title="Fullscreen" style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrows-fullscreen" /></button>
            </div>
          )}
          <div className="fv-speed" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="badge text-bg-primary" style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 6px" }}>{rate.toFixed(1)}×</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
              <input type="range" tabIndex={-1} min="0.1" max="1" step="0.1" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} style={{ width: 90, accentColor: "#6366f1", height: 4 }} />
            </div>
            <div style={{ display: "flex", gap: 3, alignItems: "center", border: "1px solid var(--border)", borderRadius: 6, padding: 2, background: "var(--surface-2)" }}>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(false)} className={`btn btn-sm ${!seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 second (←/→)">1s</button>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(true)} className={`btn btn-sm ${seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 frame (~33ms)">1f</button>
            </div>
            <span style={{ flex: 1 }} />
            {(isVideo || gifAsVideoEff) && (
              <button type="button" tabIndex={-1} className={`btn btn-sm ${tracking ? "btn-primary" : "btn-outline-secondary"}`} onClick={() => cycleTracking()} title={tracking ? `${trackBg ? "BG tracking" : "Subject tracking"} on (⇧T switches mode) — click to stop and reset` : `Stabilization off — click to start ${trackPrefRef.current === "point" ? "subject tracking" : "BG tracking"}`} style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-camera-video" /> {tracking ? (trackBg ? "BG tracking" : "Subject tracking") : "Track"}</button>
            )}
            {(isImage || isVideo || gifAsVideoEff) && (
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={rotateFile} title={`Rotate 90° (⇧R)` + (rotate ? ` · now ${rotate}°` : "")} style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrow-clockwise" /> Rotate</button>
            )}
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={cycleEndMode} title={`End mode: ${endMode} (r)`} style={{ padding: "4px 6px", fontSize: 11, minWidth: 52, borderRadius: 6, border: "1px solid " + (endMode !== "none" ? "transparent" : "var(--border)"), background: endMode === "next" ? "#6366f1" : endMode === "repeat" ? "#10b981" : endMode === "random" ? "#8b5cf6" : "var(--surface-2)", color: endMode !== "none" ? "#fff" : "var(--muted)" }}>
              <i className={`bi ${endMode === "next" ? "bi-skip-forward-fill" : endMode === "repeat" ? "bi-repeat" : endMode === "random" ? "bi-shuffle" : "bi-arrow-repeat"}`} /> {endMode === "next" ? "Next" : endMode === "repeat" ? "Loop" : endMode === "random" ? "Shuffle" : "End"}
            </button>
          {(isVideo || isAudio || gifAsVideoEff) && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {(isVideo || isAudio || gifAsVideoEff) && (
                  <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute (m)" : "Mute (m)"} style={{ color: muted ? "#f87171" : undefined, minWidth: 36, padding: "4px 6px", fontSize: 11 }}><i className={`bi ${muted ? "bi-volume-mute-fill" : "bi-volume-up-fill"}`} /></button>
                )}
                <button type="button" tabIndex={-1} className="btn btn-sm btn-primary" onClick={() => { if (!videoRef.current) return; if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); videoRef.current?.focus(); }} style={{ padding: "4px 8px", fontSize: 11 }}>
                  <i className={`bi ${isPlaying ? "bi-pause-fill" : "bi-play-fill"}`} /> {isPlaying ? "Pause" : "Play"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    {showHelp && <ShortcutsHelp active="viewer" onClose={() => setShowHelp(false)} />}
    <ConfirmModal
      open={confirmOpen}
      title="Delete file"
      message={`Delete "${parseFolderBase(filePathEff).base}"? This removes the file from /media.`}
      confirmLabel="Delete"
      danger
      onCancel={() => setConfirmOpen(false)}
      onConfirm={handleConfirmDelete}
    />
    <AlertModal open={alertState.open} title={alertState.title || "Error"} message={alertState.message} onClose={() => setAlertState({ open: false, title: "", message: "" })} />
    </>
  );
}
