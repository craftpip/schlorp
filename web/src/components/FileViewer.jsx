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
// Auto-center: while stabilization runs, the pan offset is eased back to the
// framing the user chose, which is recorded in st.userX/userY by the gesture that
// chose it. The tracked point's own term is part of the transform and the bg
// compensation rides on bgX/bgY, so neither of them is in the offset and neither
// is corrected here. The pull therefore never takes a pan back: it only corrects
// the offset moving away from the framing, so letting go of the mouse changes
// nothing about where the user put the picture.
const TRACK_AUTOCENTER_REACH = 0.2;
const TRACK_AUTOCENTER_PULL = 0.35;
const TRACK_AUTOCENTER_MAX = 2.2;
const TRACK_AUTOCENTER_MAXDRIFT = 0.5;
const TRACK_AUTOCENTER_EPS = 0.05;
// In bg mode the visible pan is the compensation plus that offset, and easing
// the offset alone cannot bring the picture back: the compensation random-walks
// as the camera moves and only decays at TRACK_BG_LEAK, which is slow enough
// that the frame can sit off center for the rest of the clip. So the
// compensation gets the same treatment: the view rooms freely, and only once it
// is out of the band does a countdown start, and once that has run out the
// spring below walks it back to the middle - fast enough to read as the frame
// coming home rather than as a slow creep. The countdown re-arms every time the
// view ends up parked at zero, so every excursion gets the same full delay.
// There is deliberately no gate on how still the shot is: a held frame is never
// truly still, so a gate that waits for stillness is a gate that never opens.
// The band is a fraction of the screen short side, converted into the canvas
// pixels the compensation is actually measured in, so the roam distance looks
// the same whatever the video resolution and zoom, and the spring is a plain
// exponential so it lands the same way at any frame rate.
const TRACK_AUTOCENTER_BAND = 0.1;
const TRACK_AUTOCENTER_HOLD = 2000;
const TRACK_AUTOCENTER_RAMP = 0.25;
const TRACK_AUTOCENTER_HOME = 0.25;
const TRACK_HOLD_MS = 350;
// How hard a match is pulled towards the predicted position, per squared pixel.
// This has to stay small next to the size of the differences it is meant to
// overrule: a wrong match a few pixels away can easily be a couple of hundred
// worse than the right one, so a large stick term simply pins the search to
// where the subject was predicted to be. The subject then never actually gets
// picked up, it lags behind fast movement, and it is eventually declared lost.
const TRACK_STICK = 6;
// How far out a match has to be before it is treated as a candidate for somewhere
// else in the frame rather than as the subject having moved, and how many frames
// running it then has to come back to the same place before the point, the
// template and the fingerprint are allowed to go there. Past this distance the
// template is a poor guide anyway -- it is a flat SSD patch, so a subject that is
// turning brings up a fresh best match somewhere else on itself every frame, and
// a subject with any repeated structure on it brings up a second, equally good
// one. Adopting those on sight is what made the view jump between two positions:
// whichever of them won last frame became the template for this one, so the two
// took turns. Holding the lock until a candidate agrees with itself over
// consecutive frames leaves the following of a subject that genuinely moved
// untouched -- that motion is continuous, so it agrees immediately -- and only
// refuses the alternation, which never does.
const TRACK_LOCK_FAR = 30;
// Two frames running, not one: a single frame cannot tell a candidate that is
// going to stay from one that is going to be replaced next frame, which is the
// whole of what has to be told apart here.
const TRACK_LOCK_RUN = 2;
// How close together two consecutive candidates have to be to count as the same
// candidate. It grows with the tracked speed, because a subject that is really
// moving does not come back to the same pixel, and a fixed window would make a
// fast subject look like an alternating one.
const TRACK_LOCK_AGREE = 8;
// Foreground tracking. The foreground is whatever is in front of the
// background, so nothing here holds a picture of the subject and nothing can go
// stale when what is on screen is not what was there a moment ago. What is held
// instead is a picture of the background, and the foreground is what fails to
// match it.
const TRACK_FG_BLOCK = 8;      // block size of the background comparison
const TRACK_FG_DIFF = 9;       // mean luma difference (0-255) that makes a block foreground
const TRACK_FG_LEARN = 0.16;   // how fast the model is taught background
const TRACK_FG_DRIFT = 0.01;   // object over a spot whose background is known -- the model barely moves
const TRACK_FG_UNSEEN = 0.05;  // object over a spot where background was never seen -- best guess allowed to settle
const TRACK_FG_MASS = 900;     // difference*area needed before there is a subject
const TRACK_FG_FOLLOW = 0.18;  // how much of the way to the centroid the point moves
const TRACK_FG_SLEW = 2;      // canvas px the point may travel in one tick, however far the centroid went
const TRACK_FG_DEAD = 0.05;   // fraction of the short side: centroid jitter below this is ignored
const TRACK_FG_MISS = 12;      // ticks without a foreground before it is reported gone
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
// How long a file with no timeline of its own stays on screen before the end
// mode moves on. A video or an audio track ends itself by firing `ended`; an
// image and a file the browser cannot preview have nothing to fire, which left
// the end mode inert on them and the viewer sitting on the same picture until
// the user navigated away by hand. The dwell is only a stand-in for that missing
// end, so it is counted from the file being on screen rather than from its own
// length: five seconds is about as long as a still is worth looking at.
const STILL_DWELL_MS = 5000;
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
// Per-patch displacement for every grid patch that still looks like itself, and
// the median of those displacements: the picture moving across most of the frame
// is the camera moving. Patches that no longer match are left out of the median
// on purpose, so whatever is changing in the scene cannot drag the camera
// estimate along with it. Shared, because the background model in foreground
// tracking is warped by this same number and the two have to agree.
function gridMotion(img, st) {
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
  if (gdx.length < 3) return { n: gdx.length, medDx: 0, medDy: 0 };
  gdx.sort((a, b) => a - b); gdy.sort((a, b) => a - b);
  return { n: gdx.length, medDx: medOf(gdx), medDy: medOf(gdy) };
}
// The tracking helpers are module level but the React state they report to is
// not, so the setter is parked here by the component on every render and called
// from inside the tick.
let reportTrackLost = null;
// How far the picture moved between the last two frames, over a range wide
// enough to survive the tracker not running on every frame.
//
// The grid template match is measured for the background mode, where the motion
// per tick is small and a patch that moved more than TRACK_JUMP has stopped
// being background. Here a tick can cover several frames of camera movement at
// once whenever the page is slow, and the picture still has to be lined up or
// every pixel reads as foreground and the centroid is the middle of the frame.
// So it is estimated from a heavily reduced copy of the frame by brute-force
// translation, coarse step then fine. The whole frame votes on it, which is
// also why it is safe: something moving inside the frame is part of the
// residual it leaves behind, not part of the answer.
function globalMotion(st, lum) {
  const rw = st.rw, rh = st.rh;
  const lw = Math.max(16, Math.round(rw / 4)), lh = Math.max(16, Math.round(rh / 4));
  const n = lw * lh;
  let lo = st.loBuf;
  if (!lo || lo.length !== n) { lo = new Float32Array(n); st.loBuf = lo; st.prevLo = null; }
  for (let y = 0; y < lh; y++) {
    const y0 = Math.min(rh - 1, y * rh / lh | 0), y1 = Math.min(rh, y0 + Math.max(1, (rh / lh) | 0));
    for (let x = 0; x < lw; x++) {
      const x0 = Math.min(rw - 1, x * rw / lw | 0), x1 = Math.min(rw, x0 + Math.max(1, (rw / lw) | 0));
      let s = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) { const row = yy * rw; for (let xx = x0; xx < x1; xx++) { s += lum[row + xx]; c++; } }
      lo[y * lw + x] = c ? s / c : 0;
    }
  }
  if (!st.prevLo || st.prevLo.length !== n) { st.prevLo = lo.slice(); return { dx: 0, dy: 0 }; }
  const prev = st.prevLo;
  const score = (dx, dy, step) => {
    let s = 0, c = 0;
    for (let y = 2; y < lh - 2; y += step) {
      const pr = (y - dy) * lw, cr = y * lw;
      for (let x = 2; x < lw - 2; x += step) { const p = pr + x - dx; if (p < 0 || p >= n) continue; const d = lo[cr + x] - prev[p]; s += d < 0 ? -d : d; c++; }
    }
    return c ? s / c : Infinity;
  };
  let bd = 0, be = 0, bv = Infinity;
  for (let dy = -12; dy <= 12; dy += 4) for (let dx = -12; dx <= 12; dx += 4) { const s = score(dx, dy, 2); if (s < bv) { bv = s; bd = dx; be = dy; } }
  for (let dy = be - 3; dy <= be + 3; dy++) for (let dx = bd - 3; dx <= bd + 3; dx++) { const s = score(dx, dy, 1); if (s < bv) { bv = s; bd = dx; be = dy; } }
  prev.set(lo);

  // The quarter-size picture can only answer in quarter-size pixels, and a
  // quarter of this frame is four whole pixels. When the camera moves slowly --
  // which is the normal case, a couple of pixels between ticks -- that rounds
  // the real movement to nothing, or to four pixels when it was two, and the
  // model gets warped by the wrong amount either way. A model compared against
  // the wrong place looks foreground everywhere, and the block verdicts flip as
  // the error changes, which is what shakes the view. So the coarse answer is
  // only used to get close, and the last few pixels are measured at full size.
  let prevL = st.prevLum;
  if (!prevL || prevL.length !== rw * rh) { prevL = new Float32Array(rw * rh); prevL.set(lum); st.prevLum = prevL; return { dx: 0, dy: 0 }; }
  const near = (dx, dy) => {
    let s = 0, c = 0;
    for (let y = 3; y < rh - 3; y += 3) {
      const pr = (y - dy) * rw, cr = y * rw;
      for (let x = 3; x < rw - 3; x += 3) { const p = pr + x - dx; if (p < 0 || p >= prevL.length) continue; const d = lum[cr + x] - prevL[p]; s += d < 0 ? -d : d; c++; }
    }
    return c ? s / c : Infinity;
  };
  let fx = bd * (rw / lw), fy = be * (rh / lh);
  let fd = fx, fe = fy, fv = Infinity;
  const R = 5;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const s = near(fx + dx, fy + dy); if (s < fv) { fv = s; fd = fx + dx; fe = fy + dy; } }
  prevL.set(lum);
  return { dx: fd, dy: fe };
}
// Foreground as "the background stops matching here".
//
// This replaces comparing a frame against a stored picture of the background,
// which cannot work on this material: between two samples the camera moves far
// enough that even after lining the frames up, most of the frame still reads as
// changed, so an absolute difference threshold finds foreground everywhere and
// its "centre" is just the middle of the picture. Matching small patches of
// background asks a question that does not have that failure: this bit of scene,
// is it still the same bit of scene? Camera movement is answered by each patch
// looking a short distance for itself, and a uniform change of light moves every
// patch's score together, so the score a patch has to beat to count as foreground
// is read off the other patches in the same frame. Nothing here is a fixed
// brightness, which is what a 3D object turning in front of the lens needs: every
// side of it is new, and none of them is the background, so all of them score as
// foreground whichever way it is facing.
const FG_PATCH = 16;      // side of a background patch
const FG_STEP = 2;        // pixels between the samples taken inside a patch
const FG_GRID = 20;       // distance between patch centres
const FG_RAD = 6;         // how far a patch looks for itself
const FG_SSTEP = 2;       // pixels between the positions a patch tries
const FG_MUL = 2.2;       // times the frame's own background score to count as foreground
const FG_ADD = 25;        // ...or this much over it, whichever is more
const FG_MINPATCH = 2;    // fewer foreground patches than this and there is no subject
const FG_MASS = 260;      // total mismatch needed before there is a subject
function fgCapture(lum, rw, x, y) {
  const t = new Int32Array((FG_PATCH / FG_STEP) * (FG_PATCH / FG_STEP));
  let n = 0;
  for (let j = 0; j < FG_PATCH; j += FG_STEP) { const r = (y + j) * rw; for (let i = 0; i < FG_PATCH; i += FG_STEP) t[n++] = lum[r + x + i]; }
  return t;
}
function fgMatch(lum, rw, rh, t, x, y) {
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -FG_RAD; dy <= FG_RAD; dy += FG_SSTEP) {
    const py = y + dy;
    if (py < 0 || py + FG_PATCH > rh) continue;
    for (let dx = -FG_RAD; dx <= FG_RAD; dx += FG_SSTEP) {
      const px = x + dx;
      if (px < 0 || px + FG_PATCH > rw) continue;
      let s = 0, k = 0;
      for (let j = 0; j < FG_PATCH; j += FG_STEP) { const r = (py + j) * rw; for (let i = 0; i < FG_PATCH; i += FG_STEP, k++) { const d = lum[r + px + i] - t[k]; s += d < 0 ? -d : d; } }
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  }
  return { dx: bx, dy: by, score: best === Infinity ? 1e9 : best };
}
function buildFgPatches(st, lum) {
  const rw = st.rw, rh = st.rh, m = FG_PATCH + 2;
  const xs = [], ys = [];
  for (let x = m; x + FG_PATCH + m <= rw; x += FG_GRID) xs.push(x);
  for (let y = m; y + FG_PATCH + m <= rh; y += FG_GRID) ys.push(y);
  st.pgCols = xs.length; st.pgRows = ys.length;
  st.patches = [];
  for (let r = 0; r < ys.length; r++) for (let c = 0; c < xs.length; c++) {
    st.patches.push({ c, r, x: xs[c], y: ys[r], t: fgCapture(lum, rw, xs[c], ys[r]), mx: 0, my: 0, score: 0, w: 0 });
  }
}
function trackPatches(st, lum) {
  const rw = st.rw, rh = st.rh;
  if (!st.patches || !st.patches.length) { buildFgPatches(st, lum); return; }
  const P = st.patches;
  // Each patch looks for itself near where it was last seen, moved by the
  // camera's last known motion so the search is a short one.
  for (const p of P) {
    const r = fgMatch(lum, rw, rh, p.t, p.x + p.mx, p.y + p.my);
    p.nx = p.x + p.mx + r.dx; p.ny = p.y + p.my + r.dy; p.score = r.score;
  }
  const scores = P.map(p => p.score).sort((a, b) => a - b);
  // What an undisturbed patch scores in this frame is the yardstick, read off
  // the low end so a large subject cannot raise the bar for itself.
  const base = scores[Math.floor(scores.length * 0.4)] || 1;
  const cut = Math.max(base * FG_MUL, base + FG_ADD);
  // The camera is what most of the picture is doing, so it is the median move of
  // the patches that still match -- the ones that stopped matching are left out
  // on purpose, or the subject would be taken for camera movement.
  const gx = [], gy = [];
  const P2 = P.length;
  for (let i = 0; i < P2; i++) {
    const p = P[i];
    p.w = p.score <= cut ? 0 : p.score - cut;
    if (p.w) { p.nx = p.x + p.mx; p.ny = p.y + p.my; continue; }
    const dx = p.nx - p.x, dy = p.ny - p.y;
    if (Math.hypot(dx, dy) < 40) { gx.push(dx); gy.push(dy); }
    p.x = p.nx; p.y = p.ny; p.mx = 0; p.my = 0;
    // Still background, so this is the fresh version of it. A patch that did
    // not match keeps the template it had, which is the background the subject
    // is standing in front of.
    if (p.score <= base * 1.6) p.t = fgCapture(lum, rw, p.x, p.y);
  }
  if (gx.length >= 3) { gx.sort((a, b) => a - b); gy.sort((a, b) => a - b); st.mx = medOf(gx); st.my = medOf(gy); }
  else { st.mx = 0; st.my = 0; }
  // Averaged over each patch's neighbours before anything is decided. Patches
  // that have stopped matching on their own are noise -- a highlight, a bit of
  // compression, a place where the picture moves more than one patch can follow
  // -- and averaging leaves the patches that have stopped matching *together*,
  // which is what a subject looks like and what a scatter of noise is not. The
  // centre is then taken over the dense part only, so a few loud patches out on
  // the edge of the picture cannot swing it.
  const cols = st.pgCols, rows = st.pgRows;
  const sm = new Float64Array(P2);
  let smMax = 0, smSum = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      s += P[rr * cols + cc].w; n++;
    }
    const v = s / n;
    sm[r * cols + c] = v; smSum += v; if (v > smMax) smMax = v;
  }
  const bar = Math.max(smSum / P2, smMax * 0.55);
  let mass = 0, cx = 0, cy = 0, nfg = 0;
  for (let i = 0; i < P2; i++) {
    if (sm[i] < bar || !P[i].w) continue;
    mass += sm[i]; nfg++;
    cx += P[i].nx * sm[i]; cy += P[i].ny * sm[i];
  }
  if (nfg < FG_MINPATCH || mass < FG_MASS) {
    st.misses++;
    st.vx *= 0.9; st.vy *= 0.9;
    if (!st.lost && st.misses >= TRACK_FG_MISS) { st.lost = true; st.vx = 0; st.vy = 0; reportTrackLost(true); }
    else if (st.lost) reportTrackLost(true);
    return;
  }
  // Rounded, for the same reason as before: finer than a pixel is noise, and a
  // sub-pixel point makes a sub-pixel pan every frame, which shivers.
  const nfx = Math.round(cx / mass), nfy = Math.round(cy / mass);
  if (st.fx < 0 || st.fy < 0) { st.fx = nfx; st.fy = nfy; st.vx = 0; st.vy = 0; }
  else {
    // The deadband is wide and the follow is slow, and the point is not allowed
    // to travel more than a couple of pixels a tick towards what it is being
    // shown. The thing being shown is a weighted centre of whatever has stopped
    // matching, and that can step a long way in one tick when the picture
    // changes -- following it closely turns every one of those steps into
    // movement on screen. Damping it here means a genuine move is still followed,
    // a few frames later, and a jump is not turned into a shake.
    const dead = Math.max(3, Math.round(Math.min(rw, rh) * TRACK_FG_DEAD));
    let ddx = nfx - st.fx, ddy = nfy - st.fy;
    if (ddx > -dead && ddx < dead) ddx = 0; else ddx = ddx > 0 ? ddx - dead : ddx + dead;
    if (ddy > -dead && ddy < dead) ddy = 0; else ddy = ddy > 0 ? ddy - dead : ddy + dead;
    st.vx = st.vx * 0.5 + ddx * 0.5; st.vy = st.vy * 0.5 + ddy * 0.5;
    ddx = ddx * TRACK_FG_FOLLOW; ddy = ddy * TRACK_FG_FOLLOW;
    const step = Math.hypot(ddx, ddy);
    if (step > TRACK_FG_SLEW) { ddx = ddx / step * TRACK_FG_SLEW; ddy = ddy / step * TRACK_FG_SLEW; }
    st.fx += ddx; st.fy += ddy;
  }
  st.misses = 0;
  if (st.lost) { st.lost = false; reportTrackLost(false); }
}
function buildLum(img, st) {
  const len = st.rw * st.rh;
  let lum = st.lum;
  if (!lum || lum.length < len) { lum = new Int32Array(len); st.lum = lum; }
  const d = img.data;
  for (let n = 0, fi = 0; fi < d.length; fi += 4, n++) lum[n] = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3;
  return lum;
}
function seedFgModel(lum, st) {
  const n = st.rw * st.rh;
  if (!st.bgA || st.bgA.length !== n) { st.bgA = new Float32Array(n); st.bgB = new Float32Array(n); st.bgKnown = new Uint8Array(n); }
  for (let i = 0; i < n; i++) { st.bgA[i] = lum[i]; st.bgB[i] = lum[i]; st.bgKnown[i] = 0; }
  st.fgSeeded = true;
}
// Find the foreground and leave it on st.fx/st.fy, which is all the rest of the
// tracking path ever wanted to know: where the point it should centre is.
//
// Nothing is compared against a picture of the subject. The model is a picture
// of the background, so a subject that is not the same shape it was a second
// ago, or the same colour, or facing the other way, is not a worse match for
// being any of those things. It is the one thing about the old approach that
// could not be tuned around, and it is gone because nothing depends on it now.
//
// The comparison has to survive a moving camera or every pixel reads as
// foreground and the centroid is just the middle of the frame. So the model is
// world-locked: each tick it is warped by the camera displacement the grid
// measured, which puts the world's content back where the camera left it, and
// only then compared. Where that warp runs off the edge the camera has just
// revealed new ground, there is no history for it, so those blocks are seeded
// from the frame and left out of the judgement this tick.
//
// The model is only ever taught background, and foreground blocks still creep
// towards the frame very slowly. That creep is what stops something which stops
// moving from being reported as foreground for ever: it is no longer moving
// against the background, it is the background.
function trackForeground(st, lum, camDx, camDy) {
  const rw = st.rw, rh = st.rh;
  if (!st.fgSeeded || !st.bgA || st.bgA.length !== rw * rh) seedFgModel(lum, st);
  const A = st.bgA, B = st.bgB, K = st.bgKnown;
  const dz = TRACK_FG_BLOCK;
  // How far the content moved, held to a few blocks so one bad estimate cannot
  // shift the model a long way. The model's copy of the world is indexed by
  // where things were when it was written, so the content now on screen at x was
  // last seen at x - dx: the sample has to come from behind, not in front.
  const dx = clamp(camDx || 0, -dz, dz) | 0, dy = clamp(camDy || 0, -dz, dz) | 0;
  const Bsz = TRACK_FG_BLOCK;
  const nx = Math.max(1, Math.floor(rw / Bsz)), ny = Math.max(1, Math.floor(rh / Bsz));
  const fgb = [];
  for (let by = 0; by < ny; by++) {
    const y0 = by * Bsz, y1 = Math.min(y0 + Bsz, rh);
    for (let bx = 0; bx < nx; bx++) {
      const x0 = bx * Bsz, x1 = Math.min(x0 + Bsz, rw);
      // The model's copy of this block is only readable if the sample stayed inside it.
      const readable = x0 - dx >= 0 && y0 - dy >= 0 && x1 - dx <= rw && y1 - dy <= rh;
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * rw, mrow = (y - dy) * rw;
        for (let x = x0; x < x1; x++) { const dd = lum[row + x] - A[mrow + x - dx]; sum += dd < 0 ? -dd : dd; }
      }
      const isFg = readable && sum / ((x1 - x0) * (y1 - y0)) > TRACK_FG_DIFF;
      if (isFg) fgb.push(bx, by);
      if (!readable) {
        // The warp ran off the edge, so there is no history to compare against
        // and none to keep: the frame that lands here becomes the model again,
        // and this spot counts as never having been seen.
        for (let y = y0; y < y1; y++) { const row = y * rw; for (let x = x0; x < x1; x++) { B[row + x] = lum[row + x]; K[row + x] = 0; } }
      } else if (isFg) {
        // Something is standing here. The model is left alone, which is the whole
        // point: what is on screen is the object, and a model that is taught to
        // expect the object stops being able to tell the object from the scene.
        // That matters most for something that turns. The front and the back of
        // a turning object look nothing alike, and if the front has been written
        // into the model as background then the back is simply more of it; it is
        // held as one object either way, because neither face matches the scene
        // behind it. The scene the model holds here is the scene from before the
        // object arrived, which is the right scene to still be holding.
        for (let y = y0; y < y1; y++) {
          const row = y * rw, mrow = (y - dy) * rw;
          for (let x = x0; x < x1; x++) {
            // A spot whose background was never actually seen -- the object was
            // already there when tracking began -- has nothing better to hold, so
            // it is allowed to settle towards what is on screen instead. Only
            // slowly: a face the object turns to is new, and a model that reaches
            // it before the object turns away has swallowed the object whole.
            const a = K[row + x] ? TRACK_FG_DRIFT : TRACK_FG_UNSEEN;
            B[row + x] += (lum[row + x] - A[mrow + x - dx]) * a;
          }
        }
      } else {
        // Real background, seen with the object's own pixels nowhere near it. This
        // is the only thing that is allowed to teach the model, and once a spot
        // has been seen as background it is never unmarked, so the object can
        // cover it and uncover it as often as it likes.
        for (let y = y0; y < y1; y++) {
          const row = y * rw, mrow = (y - dy) * rw;
          for (let x = x0; x < x1; x++) { B[row + x] += (lum[row + x] - A[mrow + x - dx]) * TRACK_FG_LEARN; K[row + x] = 1; }
        }
      }
    }
  }
  // Weighted centroid over the pixels, not the block centres. A block centre is
  // quantised to the block, and a subject a few blocks across would step with it.
  let cx = 0, cy = 0, mass = 0;
  for (let i = 0; i < fgb.length; i += 2) {
    const x0 = fgb[i] * Bsz, x1 = Math.min(x0 + Bsz, rw), y0 = fgb[i + 1] * Bsz, y1 = Math.min(y0 + Bsz, rh);
    for (let y = y0; y < y1; y++) {
      const row = y * rw, mrow = (y - dy) * rw;
      for (let x = x0; x < x1; x++) {
        const dd = lum[row + x] - A[mrow + x - dx];
        const wt = (dd < 0 ? -dd : dd) - TRACK_FG_DIFF;
        if (wt > 0) { cx += x * wt; cy += y * wt; mass += wt; }
      }
    }
  }
  st.bgA = B; st.bgB = A;
  if (mass >= TRACK_FG_MASS) {
    // Rounded to whole canvas pixels. The centroid is a weighted mean of a grid
    // of block verdicts, so the part of it finer than a pixel is noise, and a
    // sub-pixel point makes a sub-pixel pan on every frame -- which is exactly
    // the fine shivering this is here to stop.
    const nfx = Math.round(cx / mass), nfy = Math.round(cy / mass);
    if (st.fx < 0 || st.fy < 0) { st.fx = nfx; st.fy = nfy; st.vx = 0; st.vy = 0; }
    else {
      // Follow the centroid a fixed fraction of the way each tick, and ignore
      // movement smaller than a deadband first. The centroid of a real subject
      // wanders a pixel or two from frame to frame as the block verdicts flip
      // under it; without the band that wander is chased in full and the view
      // shivers. The band is taken off the error rather than zeroing it, so the
      // point is pulled to the edge of the band and then holds still there
      // instead of oscillating inside it -- and the subject is still centred to
      // within the band rather than drifting off over time.
      const dead = Math.max(2, Math.round(Math.min(rw, rh) * TRACK_FG_DEAD));
      let ddx = nfx - st.fx, ddy = nfy - st.fy;
      if (ddx > -dead && ddx < dead) ddx = 0; else ddx = ddx > 0 ? ddx - dead : ddx + dead;
      if (ddy > -dead && ddy < dead) ddy = 0; else ddy = ddy > 0 ? ddy - dead : ddy + dead;
      st.vx = st.vx * 0.5 + ddx * 0.5; st.vy = st.vy * 0.5 + ddy * 0.5;
      st.fx += ddx * TRACK_FG_FOLLOW; st.fy += ddy * TRACK_FG_FOLLOW;
    }
    st.misses = 0;
    if (st.lost) { st.lost = false; reportTrackLost(false); }
  } else {
    // Nothing in front of the background. The point stays where it was, so the
    // view holds still rather than wandering, and the velocity decays on its own.
    st.misses++;
    st.vx *= 0.9; st.vy *= 0.9;
    if (!st.lost && st.misses >= TRACK_FG_MISS) { st.lost = true; st.vx = 0; st.vy = 0; reportTrackLost(true); }
    else if (st.lost) reportTrackLost(true);
  }
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
  // The tracker runs outside React, on a rAF/video-frame callback, and the
  // helpers it calls live at module level, so the setter is handed to them
  // rather than imported. See reportTrackLost.
  reportTrackLost = setTrackLost;
  const [trackBg, setTrackBg] = useState(false);
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
  // "point" is the old placed-subject mode, which is gone: anyone who had that
  // stored gets the foreground mode, which is what replaced it.
  const [trackPref, setTrackPref] = useState(() => { try { const p = localStorage.getItem("xdl_viewer_track"); return p === "bg" || p === "fg" || p === "point" ? (p === "point" ? "fg" : p) : "none"; } catch { return "none"; } });
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
  const startFgRef = useRef(null);
  const cycleTrackRef = useRef(null);
  const autoCenterToggleRef = useRef(null);
  const recenterRef = useRef(null);
  const trackPrefRef = useRef(trackPref);
  trackPrefRef.current = trackPref;
  const applyTrackPrefRef = useRef(null);
  const randCursorRef = useRef(-1);
  const fmtTime = (s) => { if (!s || Number.isNaN(s)) return "0:00"; const m = Math.floor(s/60); const sec = String(Math.floor(s%60)).padStart(2,"0"); return `${m}:${sec}`; };
  const [seekHint, setSeekHint] = useState(null);
  // Time bubble on the seek dot: pointer x -> fraction of the track -> mm:ss, so
  // the dot always says where it is (and where you are about to land) before release.
  const showSeekHint = useCallback((e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setSeekHint({ ratio, t: ratio * (duration || 0) });
  }, [duration]);
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
  // The same end mode for a file that never ends by itself. Loop and End stay
  // no-ops: a still has nothing to replay, and not moving on is what it already
  // does. Only the two modes that mean "move on" are given a dwell, and they go
  // through the same dispatch as the buttons, so the random history is walked
  // forward and back the same way whichever one moved the viewer on.
  useEffect(() => {
    if (isVideo || isAudio || gifAsVideoEff) return;
    const mode = endModeRef.current;
    if (mode !== "next" && mode !== "random") return;
    // A file the browser cannot preview never reports itself ready -- there is no
    // load event to report one -- so its dwell starts once it is on the stage,
    // while an image has to have actually arrived before its five seconds run.
    if (!mediaReady && isFormatKnown) return;
    const timer = setTimeout(() => { if (dispatchNextRef.current) dispatchNextRef.current(); }, STILL_DWELL_MS);
    return () => clearTimeout(timer);
  }, [loadedUrl, endMode, isVideo, isAudio, gifAsVideoEff, isFormatKnown, mediaReady]);
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
  // The pan the user can actually see. While tracking that is the tracking
  // view's pan, not the pan state: the render reads the former, and the tracking
  // tick moves it every frame without ever touching the state.
  const visiblePan = () => (trackingRef.current && trackStateRef.current ? { ...trackViewRef.current.pan } : { ...pan });
  // Put a wanted pan on screen while tracking. The visible pan is the tracked
  // part plus the user's own offset (st.offX/offY), so a gesture moves that
  // offset and the tracking tick reproduces the pan from there instead of
  // easing back to where the gesture started. At zoom 1 the offset goes to zero
  // and the tracked part alone holds the view, which is the same picture the
  // tracked view shows when nothing is panned. Touches need this because the
  // pan state is not what the render reads while tracking, so a gesture that
  // only moved state moved nothing at all.
  const applyTrackPan = (want, rect, z) => {
    const st = trackStateRef.current;
    if (!st || !rect) return null;
    const tv = trackViewRef.current;
    const rot = rotateRef.current;
    if (Number.isFinite(z)) tv.zoom = Math.min(4, Math.max(1, z));
    const keepX = st.offX || 0, keepY = st.offY || 0;
    st.offX = 0; st.offY = 0;
    const base = st.mode === "bg"
      ? { x: st.bgX * (st.cPerCanvas || 1) * tv.zoom, y: st.bgY * (st.cPerCanvas || 1) * tv.zoom }
      : computeCenterPan(st, tv.zoom, rect, rot);
    st.offX = keepX; st.offY = keepY;
    let shown = want;
    if (tv.zoom <= 1) { st.offX = 0; st.offY = 0; shown = base; }
    else { st.offX = want.x - base.x; st.offY = want.y - base.y; }
    // The framing this gesture chose, in the terms the auto-center target is
    // built from. The gesture has just solved the offset for, so the offset is
    // the answer in both modes: in bg mode the compensation rides on bgX/bgY,
    // and in subject mode the tracked point's term is the base it was taken off
    // (offX = want - base), so neither leaves anything of its own in it. Zoomed
    // all the way out there is nothing to frame, so the offset - and with it the
    // framing - is 0 and the pull keeps the view at the tracked one.
    st.userX = st.offX; st.userY = st.offY;
    tv.pan = shown;
    tv.transform = `translate(${shown.x}px, ${shown.y}px) rotate(${rot}deg) scale(${tv.zoom})`;
    const v = videoRef.current;
    if (v) v.style.transform = tv.transform;
    return shown;
  };
  // A seek replaces the picture, so the tracker has to be told: everything it
  // knows describes the shot that was just left. Re-capturing where the subject
  // used to be would lock a patch of whatever is now there, and in bg mode the
  // compensation that was cancelling the old camera motion would be read as the
  // new camera's motion and carried into the new shot. So the tracked part is
  // dropped, and the next tick puts it back by looking for the subject by
  // identity -- fx = -1 is the "position unknown" marker (a real point is
  // clamped into the frame, so it cannot be -1) and the miss count is already
  // at the lost threshold, which is what puts the tracker on the full-frame
  // sweep on that very next tick instead of after ten misses.
  //
  // `seeking` tells the tick the frame on screen is about to be replaced: the
  // currentTime guard that skips work while the time is standing still has to
  // step aside, or the view transform for the landed frame is only computed
  // after it has already been shown unstabilized. It is consumed by the first
  // tick that runs, so a jog -- a seeked every 33ms -- is never starved.
  //
  // The user's own pan and the zoom are not touched: a seek moves the playhead,
  // it is not a reset.
  const rearmTracking = () => {
    const st = trackStateRef.current;
    if (!st) return;
    st.seeking = true;
    st.acArmed = false; st.acHold = TRACK_AUTOCENTER_HOLD; st.acRamp = 0;
    if (st.mode === "bg") {
      st.bgX = 0; st.bgY = 0; st.bgVX = 0; st.bgVY = 0;
      st.bgRegrab = true;
    } else {
      st.fx = -1; st.fy = -1; st.vx = 0; st.vy = 0;
      st.misses = TRACK_BG_MISS; st.lost = true;
      // The background model describes the frames before the seek, which are not
      // the frames after it, so it is dropped and seeded again from the frame
      // that lands. Left in place it would call the whole new shot foreground.
      st.fgReseed = true;
      // The pending candidate was found on the frame that has just been replaced,
      // so confirming it against the new one would adopt a position that was
      // never on screen.
      st.lkX = null; st.lkY = null; st.lkRun = 0;
    }
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
      // Zooming is not a framing decision, so the remembered one is left alone --
      // it is in screen pixels, which is what a zoom keeps: the picture stays
      // where the user put it and simply gets bigger around that point. Backing
      // out to 1x is the exception, and it has to happen before the pan below is
      // built, because the whole frame is on screen at 1x: there is no framing
      // left to hold, so the offset is spent and the pull takes it back to the
      // tracked view on its own.
      if (z <= 1) { st.userX = 0; st.userY = 0; st.offX = 0; st.offY = 0; }
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

  useEffect(() => {
    if (!trackingRef.current) return;
    const v = videoRef.current;
    if (!v) return;
    const st = trackStateRef.current;
    if (!st) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const z = trackViewRef.current.zoom;
    const rot = rotateRef.current;
    const pan = st.mode === "bg"
      ? { x: st.bgX * st.cPerCanvas * z + (st.offX || 0), y: st.bgY * st.cPerCanvas * z + (st.offY || 0) }
      : computeCenterPan(st, z, rect, rot);
    trackViewRef.current.pan = pan;
    trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${z})`;
    v.style.transform = trackViewRef.current.transform;
    setPan(pan);
  }, [rotate]);

  // Foreground tracking. The same shape as the BG one -- same canvas, same
  // capture size, same pan write -- and the difference is what the tick does
  // with the frame: it does not look for a subject, it looks for what is not
  // background, and nothing has to be placed or picked first.
  const startFgTracking = () => {
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
      // The point starts unknown: there is nothing to centre on until the first
      // frame that has a foreground in it, and until then the view is held.
      fx: -1, fy: -1, vx: 0, vy: 0, age: 0, offX: 0, offY: 0, lost: true, misses: 0, frames: 0,
      // The framing the user chose, in the same screen pixels a gesture measures:
      // the auto-center pull moves offX/offY, so the framing has to be remembered
      // apart from it or a deliberate pan is read as drift and walked back to the
      // middle of the video the moment the drag ends. Zero until the user pans,
      // which is why a viewer who never does is unaffected.
      userX: 0, userY: 0,
      mode: "fg", seeking: false, warm: 2,
      // The background model, the reduced copy of the last frame the camera
      // motion is measured from, and the size the model was built for.
      bgA: null, bgB: null, fgSeeded: false, fgReseed: false, loBuf: null, prevLo: null, fgRW: -1, fgRH: -1,
      acArmed: false, acHold: TRACK_AUTOCENTER_HOLD, acRamp: 0,
      bgX: 0, bgY: 0, bgVX: 0, bgVY: 0, bgMaxX: 0, bgMaxY: 0,
      rvfc: typeof v.requestVideoFrameCallback === "function",
      raf: 0, tTime: -1, gen: ++trackGenRef.current,
      onSeeked: () => { if (trackStateRef.current) rearmTracking(); },
    };
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    st.canvas.width = rw; st.canvas.height = rh;
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    st.ctx = st.canvas.getContext("2d", { willReadFrequently: true });
    st.ctx.drawImage(v, 0, 0, rw, rh);
    const img = st.ctx.getImageData(0, 0, rw, rh);
    // The background model starts as the first frame, so there is a "what is
    // normal here" to compare against straight away instead of a blank.
    seedFgModel(buildLum(img, st), st);
    st.fgRW = rw; st.fgRH = rh;
    trackStateRef.current = st;
    trackingRef.current = true;
    const cz = Math.max(1, zoom);
    const pan0 = { x: st.offX, y: st.offY };
    trackViewRef.current = { tracking: true, zoom: cz, pan: pan0, transform: `translate(${pan0.x}px, ${pan0.y}px) rotate(${rot}deg) scale(${cz})` };
    v.style.transformOrigin = "50% 50%";
    v.style.transform = trackViewRef.current.transform;
    v.addEventListener("seeked", st.onSeeked);
    setTrackLost(false);
    setTrackBg(false);
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
      fx: 0, fy: 0, vx: 0, vy: 0, age: 0, offX: 0, offY: 0, lost: false, misses: 0, frames: 0,
      // The framing the user chose, in the same screen pixels a drag measures.
      // In BG mode offX/offY is nothing but the user's own offset -- the camera
      // compensation rides on bgX/bgY and is homed by its own band below -- so
      // this is the whole of what the pull must not take back.
      userX: 0, userY: 0,
      mode: "bg", grid: null, gridRW: -1, gridRH: -1, warm: 3, seeking: false, bgRegrab: false,
      // Auto-center state: whether the view is currently out of the band, ms of
      // countdown still owed before the compensation may be pulled in, and how
      // far the spring has ramped in (0 while it roams).
      acArmed: false, acHold: TRACK_AUTOCENTER_HOLD, acRamp: 0,
      bgX: 0, bgY: 0, bgVX: 0, bgVY: 0, bgMaxX: 0, bgMaxY: 0,
      rvfc: typeof v.requestVideoFrameCallback === "function",
      raf: 0, tTime: -1, gen: ++trackGenRef.current,
      onSeeked: () => { if (trackStateRef.current) rearmTracking(); },
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
    setTrackLost(false);
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
      // Recentre is the escape hatch out of a framing the user no longer wants,
      // so the framing it settled on is the one now remembered -- otherwise the
      // pull would hold the view at the pan just discarded and the button would
      // do nothing.
      st.userX = st.offX || 0; st.userY = st.offY || 0;
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
  const applyTrackPref = () => {
    const st = trackStateRef.current;
    if (st && trackingRef.current) return;
    const el = videoRef.current;
    if (!el || el.tagName !== "VIDEO" || showImageRef.current) return;
    const p = trackPrefRef.current;
    if (p === "bg") startBgTracking();
    else if (p === "fg") startFgTracking();
  };
  const cycleTracking = () => {
    const st = trackStateRef.current;
    if (!st) { setTrackPref("fg"); if (startFgRef.current) startFgRef.current(); return; }
    if (st.mode === "fg") { setTrackPref("bg"); startBgTracking(); return; }
    setTrackPref("none");
    stopTracking();
  };
  // Put the point's centred view on screen. Shared by every mode that centres a
  // point, because the point is the only thing they disagree about: the
  // foreground centroid, or a placed subject, both end up on st.fx/st.fy and
  // both want the same easing. noPoint is the "nothing to centre yet" case and
  // holds the view where it is.
  const writeCenterPan = (st, v, rect, rot, noPoint) => {
    const cz = trackViewRef.current.zoom;
    const target = computeCenterPan(st, cz, rect, rot);
    const cur = trackViewRef.current.pan;
    let pan = noPoint ? cur : { x: cur.x + (target.x - cur.x) * trackSmoothRef.current, y: cur.y + (target.y - cur.y) * trackSmoothRef.current };
    if (!noPoint) {
      // No one tick may move the picture more than a few pixels. A subject that
      // genuinely moves is followed over several ticks instead of jumped after,
      // and a single bad frame -- a block verdict flipping, a motion estimate
      // landing a pixel out -- cannot jolt the view. This is a fixed number of
      // screen pixels rather than a share of the frame: the frame is often two
      // thousand pixels wide here, where a couple of percent of it is a jump big
      // enough to see, and a jump is the thing being prevented.
      const lim = 2.5;
      const dx = pan.x - cur.x, dy = pan.y - cur.y;
      const d = Math.hypot(dx, dy);
      if (d > lim) pan = { x: cur.x + dx / d * lim, y: cur.y + dy / d * lim };
    }
    // Whole pixels only. A translate of a fraction of a pixel makes the browser
    // resample the picture to draw it, and that resampling is what a fine
    // shimmer looks like even when the numbers barely move. On a whole pixel it
    // can pass the picture straight through, so the view either moves a visible
    // amount or does not move at all.
    pan = { x: Math.round(pan.x), y: Math.round(pan.y) };
    const prev = trackViewRef.current.pan;
    if (pan.x !== prev.x || pan.y !== prev.y) {
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${cz})`;
      if (v.style.transform !== trackViewRef.current.transform) v.style.transform = trackViewRef.current.transform;
    }
  };
  const trackingTick = () => {
    const st = trackStateRef.current;
    if (!st || !trackingRef.current || st.gen !== trackGenRef.current) return;
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO") { stopTracking(); return; }
    // A seek is in flight: the frame on screen is about to be replaced, so the
    // "the time is standing still, nothing to do" guard has to step aside and
    // this tick has to run on the landed frame rather than wait for the next
    // decoded one. The flag is spent here, once.
    if (!st.seeking && !st.rvfc && v.currentTime === st.tTime) return;
    st.seeking = false;
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
    // A seek parks the point off at (-1,-1) until the subject is found again.
    // That is a search anchor, not a place in the frame, and the pan is computed
    // from the point -- so reading it as a position shoves the picture off into a
    // corner by a letterbox-bar's worth of pixels on every seek, and a loop
    // restart is a seek. Nothing is being tracked at that point, so the view is
    // held where it was until there is something to centre on again.
    const noPoint = st.fx < 0 || st.fy < 0;
    const ctx = st.ctx;
    ctx.drawImage(v, 0, 0, rw, rh);
    const img = ctx.getImageData(0, 0, rw, rh);
    // Keep the view from ever sitting far outside the frame. In bg mode the
    // compensation itself is allowed to run out to TRACK_BG_CLAMP of the frame
    // and then just stops there, so the picture can sit half a frame off with
    // nothing pulling it back; here the drift in the pan offset is measured every
    // tick and eased back, firmly once it is past a small band. What counts as
    // drift is the offset moving away from the framing the user chose, never the
    // offset itself: the tracked point's term is part of the transform, so a
    // target built from the bare video center read a deliberate pan as drift and
    // walked it back to the middle of the video the moment a drag ended. In bg
    // mode the compensation gets its own, much later pass below. Paused while the
    // user drags, and skipped when auto-center is off.
    if (autoCenterRef.current && !dragRef.current.dragging) {
      const now = performance.now();
      const dt = st.acT ? Math.min(0.25, (now - st.acT) / 1000) : 0;
      st.acT = now;
      if (dt > 0) {
        const z = trackViewRef.current.zoom;
        // tX/tY is the offX/offY that puts the view back on its reference, and
        // (offX - tX) is the drift you can see. The reference is the framing the
        // last gesture recorded in userX/userY -- the user's own offset, with the
        // tracker's share of the picture left where it belongs -- so this spring
        // holds the view where the user put it and only corrects the offset
        // drifting away from there. A viewer who never pans has a framing of 0
        // and the offset stays at 0.
        const tX = st.userX || 0, tY = st.userY || 0;
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
        if (st.mode === "bg") {
          // The compensation is what actually carries the view here, so this is
          // what has to come home for the frame to end up in the middle. It roams
          // for free until it is out of the band, then TRACK_AUTOCENTER_HOLD of
          // countdown runs, and then the spring ramps in and walks it back. The
          // pull runs all the way to zero rather than stopping at the band - the
          // band is only what starts it - and parking at zero re-arms the
          // countdown, so the next excursion out gets the same delay again. The
          // compensation velocity is deliberately not damped: that velocity is
          // the term cancelling camera motion, and damping it is damping the
          // stabilization.
          const perPx = Math.max(0.01, (st.cPerCanvas || 1) * (z || 1));
          const band = Math.max(6, (Math.min(rect.width, rect.height) * TRACK_AUTOCENTER_BAND) / perPx);
          if (Math.hypot(st.bgX, st.bgY) > band) {
            if (!st.acArmed) { st.acArmed = true; st.acHold = TRACK_AUTOCENTER_HOLD; st.acRamp = 0; }
            else {
              st.acHold -= dt * 1000;
              if (st.acHold <= 0) st.acRamp = Math.min(1, st.acRamp + dt / TRACK_AUTOCENTER_RAMP);
            }
          } else if (!st.acRamp) {
            st.acArmed = false;
            st.acHold = TRACK_AUTOCENTER_HOLD;
          }
          if (st.acRamp > 0) {
            const k = Math.min(1, (st.acRamp * dt) / TRACK_AUTOCENTER_HOME);
            st.bgX -= st.bgX * k;
            st.bgY -= st.bgY * k;
            if (Math.abs(st.bgX) < TRACK_AUTOCENTER_EPS) st.bgX = 0;
            if (Math.abs(st.bgY) < TRACK_AUTOCENTER_EPS) st.bgY = 0;
            st.bgX = clamp(st.bgX, -st.bgMaxX, st.bgMaxX);
            st.bgY = clamp(st.bgY, -st.bgMaxY, st.bgMaxY);
            // Home and parked: the next excursion out starts the countdown over
            // instead of finding the spring already at full strength.
            if (!st.bgX && !st.bgY) { st.acArmed = false; st.acHold = TRACK_AUTOCENTER_HOLD; st.acRamp = 0; }
          }
        }
      }
    }
    if (st.mode === "bg") {
      // A seek replaced the whole picture, so the grid describes frames that are
      // no longer on screen. Re-grab it from the landed frame and give it the
      // same warm-up the grid gets when the capture size changes, otherwise the
      // first post-seek ticks measure the old grid against the new picture and
      // the compensation is wrong (or the grid is declared lost) right when the
      // user expects the view to be steady.
      if (st.bgRegrab) {
        st.bgRegrab = false;
        refreshGrid(img, st);
        st.gridRW = st.rw; st.gridRH = st.rh;
        st.bgX = 0; st.bgY = 0; st.bgVX = 0; st.bgVY = 0;
        st.warm = 3; st.misses = 0;
        if (st.lost) { st.lost = false; setTrackLost(false); }
      }
      if (st.gridRW !== st.rw || st.gridRH !== st.rh) {
        refreshGrid(img, st);
        st.gridRW = st.rw; st.gridRH = st.rh;
        st.bgVX = 0; st.bgVY = 0; st.warm = 3;
      }
      if (st.frames % 90 === 0) refreshGrid(img, st);
      if (st.warm > 0) { st.warm--; refreshGrid(img, st); st.frames++; return; }
      const gm = gridMotion(img, st);
      st.frames++;
      if (gm.n >= 3) {
        const medDx = gm.medDx, medDy = gm.medDy;
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
    if (st.mode === "fg") {
      // A seek replaced the whole picture, so the patches of background being
      // followed describe frames that are no longer on screen. They are dropped
      // and taken again from the frame that lands; left in place, every one of
      // them would fail to match and the whole frame would read as foreground.
      if (st.fgReseed) { st.fgReseed = false; st.patches = null; }
      if (st.rw !== st.fgRW || st.rh !== st.fgRH) { st.patches = null; st.fgRW = st.rw; st.fgRH = st.rh; st.fx = -1; st.fy = -1; }
      const lum = buildLum(img, st);
      st.frames++;
      trackPatches(st, lum);
      writeCenterPan(st, v, rect, rot, noPoint);
      return;
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
      // A match this far out is not the subject having moved, it is a candidate
      // somewhere else in the frame, and it is only allowed to take the lock once
      // it has come back to the same place on the next frame. Alternating
      // candidates never manage that -- each one replaces the last as the pending
      // one -- so the point stays where it was instead of taking turns between
      // them, and the template and the fingerprint are not handed over either,
      // which is what let a single bad frame confirm itself. Motion that is
      // continuous agrees with itself at once and is adopted on the spot. While
      // lost there is no lock to hold, so this does not apply: re-acquisition is
      // the path for a subject that is genuinely somewhere else.
      let held = false;
      if (!st.lost && resD > TRACK_LOCK_FAR) {
        const agree = Math.max(TRACK_LOCK_AGREE, speed * 1.5);
        if (st.lkRun && Math.hypot(res.x - st.lkX, res.y - st.lkY) <= agree) st.lkRun++;
        else { st.lkX = res.x; st.lkY = res.y; st.lkRun = 1; }
        held = st.lkRun < TRACK_LOCK_RUN;
      } else { st.lkX = null; st.lkY = null; st.lkRun = 0; }
      if (held) {
        // The subject is here, that is what the identity check just said, so this
        // is not a missed frame and must not age into the lost path -- the point
        // is simply not moving until the candidate stops changing its mind.
        st.misses = 0;
        st.vx *= 0.7; st.vy *= 0.7;
      } else {
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
      }
    } else if (gridOK) {
      // No match was adopted, so a candidate being held has not come back for
      // another frame running and stops counting towards one.
      st.lkX = null; st.lkY = null; st.lkRun = 0;
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
          if (!st.lost && st.misses >= 10) st.lost = true;
          if (st.lost) setTrackLost(true);
        }
      } else {
        st.misses = 0;
        st.vx *= 0.7;
        st.vy *= 0.7;
      }
    } else if (cand || res) {
      st.lkX = null; st.lkY = null; st.lkRun = 0;
      st.misses++;
      st.vx *= 0.9; st.vy *= 0.9;
      // The velocity is deliberately left running when the point is declared
      // lost: it is what carries the re-acquisition window along the path the
      // subject was taking, and it decays on its own while lost. The badge is
      // raised from here even when the point was already lost when the frame
      // arrived -- a seek puts it there on purpose (rearmTracking) and without
      // this a seek onto footage without the subject would sit there silently
      // reporting smoothness forever.
      if (!st.lost && st.misses >= 10) st.lost = true;
      if (st.lost) setTrackLost(true);
    }
    st.frames++;
    writeCenterPan(st, v, rect, rot, noPoint);
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
    if (!dragRef.current.dragging) return;
    if (dragRef.current.trackDrag) {
      const st = trackStateRef.current;
      if (!st || !trackingRef.current) return;
      const ddx = e.clientX - dragRef.current.lastX;
      const ddy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX; dragRef.current.lastY = e.clientY;
      st.offX = (st.offX || 0) + ddx;
      st.offY = (st.offY || 0) + ddy;
      // The drag is a framing decision, so the offset it moves is recorded as the
      // framing as well. Without this the pull resumes on release with a target
      // that knows nothing about the pan and walks straight back to the middle of
      // the video. At 1x the whole frame is on screen and there is nothing to
      // frame, so no framing is recorded there and the pull keeps the offset at
      // the zero it already holds.
      if (trackViewRef.current.zoom > 1) {
        st.userX = (st.userX || 0) + ddx;
        st.userY = (st.userY || 0) + ddy;
      } else {
        st.userX = 0; st.userY = 0;
      }
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
    touchRef.current = { startX: t.clientX, startY: t.clientY, startTime: videoRef.current?.currentTime || 0, isSeeking: false, isHorizontal: null, startPan: visiblePan(), lastDx: 0, pinchActive: false, trkDrag: false, wasMultiTouch: false };
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
      // While stabilization runs, the render takes its transform from
      // trackViewRef rather than from the zoom/pan state, and the tracking tick
      // rewrites the video's own transform every frame. So the pinch has to drive
      // trackViewRef here: on its own it lands in state nobody reads and is
      // overwritten before the next paint, which is why it did nothing at all.
      const trk = trackingRef.current && !!trackStateRef.current;
      const baseZoom = trk ? trackViewRef.current.zoom : zoom;
      const basePan = visiblePan();
      if (!pr.pinchActive) {
        pr.pinchActive = true;
        pr.pinchPrevDist = dist;
        pr.pinchPrevZoom = baseZoom;
        pr.pinchPrevPan = basePan;
        pr.pinchPrevMid = { x: midX, y: midY };
        // Auto-center runs on the pan offset whenever no drag is in progress, and
        // the gesture is still moving that offset. Count it as a drag for its
        // duration, the way a mouse drag does.
        if (trk) { dragRef.current.dragging = true; pr.trkDrag = true; }
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const newZoom = Math.min(4, Math.max(1, pr.pinchPrevZoom * (dist / pr.pinchPrevDist)));
        let nextPan = { x: 0, y: 0 };
        // What actually ends up on screen. Off tracking that is the pan itself;
        // on it, zoom 1 does not mean pan 0 - the tracked part still holds the
        // view - so the tracking branch below fills this in.
        let shownPan = { x: 0, y: 0 };
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
          shownPan = nextPan;
          setZoom(newZoom);
          setPan(nextPan);
          setOrigin("50% 50%");
        }
        if (trk) {
          const shown = applyTrackPan(nextPan, rect, newZoom);
          if (shown) shownPan = shown;
        }
        pr.pinchPrevZoom = newZoom;
        pr.pinchPrevPan = shownPan;
        pr.pinchPrevMid = { x: midX, y: midY };
        pr.pinchPrevDist = dist;
      }
      return;
    }
    if (zoom > 1) {
      const want = { x: touchRef.current.startPan.x + dx, y: touchRef.current.startPan.y + dy };
      // While tracking the pan state is not what is on screen, so a one-finger
      // drag has to move the tracking view too or the picture stays put.
      if (trackingRef.current && trackStateRef.current) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (applyTrackPan(want, rect, trackViewRef.current.zoom)) {
          dragRef.current.dragging = true;
          pr.trkDrag = true;
        }
      }
      setPan(want);
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
      pr.startPan = visiblePan();
      pr.lastDx = 0;
    }
    if (pr.trkDrag) {
      pr.trkDrag = false;
      dragRef.current.dragging = false;
    }
    if (pr.pinchActive && (!e.touches || e.touches.length === 0)) pr.pinchActive = false;
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
    const onShiftDown = (e) => {
      if (e.key !== "Shift" || e.repeat) return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (showImageRef.current || !videoRef.current || videoRef.current.paused) return;
      if (shiftWasPlayingRef.current) return;
      shiftWasPlayingRef.current = true;
      videoRef.current.pause();
    };
    const onShiftUp = (e) => {
      if (e.key !== "Shift") return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) { shiftWasPlayingRef.current = false; return; }
      if (!shiftWasPlayingRef.current || !videoRef.current || showImageRef.current) { shiftWasPlayingRef.current = false; return; }
      shiftWasPlayingRef.current = false;
      videoRef.current.play().catch(() => {});
    };
    const stopJog = () => {
      if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
      if (jogWasPlayingRef.current && videoRef.current) { jogWasPlayingRef.current = false; videoRef.current.play().catch(() => {}); }
    };
    const onBlur = () => { shiftWasPlayingRef.current = false; stopJog(); };
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
  useEffect(() => () => { trackGenRef.current++; trackingRef.current = false; }, []);

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
  startFgRef.current = startFgTracking;
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
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchNextRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasNext} title="Next (↓)" style={{ position: "relative", width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><span className="btn-kbd-hint">↓</span><i className="bi bi-chevron-down" /></button>
            <span className="badge" style={{ fontFamily: "var(--mono)", fontSize: 11, minWidth: 54, justifyContent: "center", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", color: "#fff", backdropFilter: "blur(6px)" }}>{endMode === "random" && randHistory.length > 1 ? `${randCursor + 1}/${randHistory.length} · ` : ""}{idx + 1} / {total}</span>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchPrevRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasPrev} title="Previous (↑)" style={{ position: "relative", width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><span className="btn-kbd-hint">↑</span><i className="bi bi-chevron-up" /></button>
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
            <button type="button" tabIndex={-1} onClick={handleDelete} disabled={deleting} className="btn btn-sm" aria-label="Delete file" title={yConfirm ? "Press p again to confirm — or click to delete" : "Delete file (press p twice)"} style={{ position: "relative", width: 36, height: 36, padding: 0, borderRadius: 999, border: yConfirm ? "1px solid #ef4444" : "1px solid rgba(255,255,255,.18)", background: yConfirm ? "#ef4444" : "rgba(0,0,0,.55)", color: yConfirm ? "#fff" : "#ff8080", backdropFilter: "blur(6px)", animation: yConfirm ? "pulse 0.6s ease infinite" : "none" }}><span className="btn-kbd-hint">P</span><i className="bi bi-trash" /></button>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" tabIndex={-1} onClick={onClose} className="btn btn-sm" aria-label="Close" style={{ position: "relative", width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><span className="btn-kbd-hint">Q</span><i className="bi bi-x-lg" /></button>
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
                        style={{ position: "relative", width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: vOpen ? "rgba(99,102,241,.9)" : vBookmarked ? "rgba(99,102,241,.85)" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}
                      >
                        <span className="btn-kbd-hint">F</span>
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
        <div ref={containerRef} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} style={{ position: "relative", flex: "1 1 auto", minHeight: 0, overflow: "hidden", background: "#080a14", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, cursor: tracking ? "grab" : "default", touchAction: "none" }}>
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

              onContextMenu={(e) => e.preventDefault()}
              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: "default", outline: "none" }}
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

              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: "default", outline: "none" }}
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
            <div onTouchStart={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} onTouchCancel={(e) => e.stopPropagation()} style={{ position: "absolute", right: 12, bottom: 12, zIndex: 4, display: "flex", alignItems: "center", gap: 6, maxWidth: "calc(100% - 24px)", pointerEvents: "none" }}>
              <div style={{ flex: "0 1 auto", minWidth: 0, background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", fontSize: 11, padding: "5px 10px", borderRadius: 999, pointerEvents: "none", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", backdropFilter: "blur(2px)" }}>{trackLost ? (trackBg ? "Background motion lost — camera view will drift" : "No foreground in view — nothing to centre") : "tracking smoothness"} <input type="number" ref={smoothInputRef} min={0} max={10} step={0.5} defaultValue={readTrackSmoothUi()} title="Scroll to adjust" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()} onChange={(e) => { const s = parseFloat(e.target.value); if (!Number.isFinite(s)) return; applyTrackSmoothUiRef.current(s); }} style={{ width: 44, fontSize: 11, background: "rgba(255,255,255,.12)", border: "1px solid rgba(255,255,255,.25)", borderRadius: 6, color: "#fff", textAlign: "center", padding: "1px 4px", pointerEvents: "auto", outline: "none" }} /></div>
              <button
                type="button"
                tabIndex={-1}
                className={`btn btn-sm ${autoCenter ? "btn-primary" : "btn-outline-secondary"}`}
                title={autoCenter ? "Recenter view (T) — auto-center on, hold to turn off" : "Recenter view (T) — auto-center off, hold to turn on"}
                style={{ position: "relative", flex: "0 0 auto", width: 30, height: 30, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: autoCenter ? "#6366f1" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)", pointerEvents: "auto", touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
                onPointerDown={(e) => { e.stopPropagation(); clearHoldTimer(); holdRef.current.fired = false; holdRef.current.timer = setTimeout(() => { holdRef.current.timer = null; holdRef.current.fired = true; toggleAutoCenter(); }, TRACK_HOLD_MS); }}
                onPointerUp={(e) => { e.stopPropagation(); clearHoldTimer(); }}
                onPointerCancel={() => clearHoldTimer()}
                onPointerLeave={() => clearHoldTimer()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (holdRef.current.fired) { holdRef.current.fired = false; return; } recenterView(); }}
              ><span className="btn-kbd-hint">T</span><i className="bi bi-bullseye" /></button>
            </div>
            </>
          )}
        </div>

        <div className="fv-controls" style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", background: "var(--surface)", display: "grid", gap: 6 }}>
            {(isVideo || isAudio || gifAsVideoEff) && (
            <div className="fv-timeline" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(current)}</span>
              <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", alignItems: "center", height: 16 }}>
                {seekHint && (
                  <span style={{ position: "absolute", bottom: "100%", left: `${seekHint.ratio * 100}%`, transform: "translateX(-50%)", marginBottom: 3, background: "rgba(0,0,0,.78)", border: "1px solid rgba(255,255,255,.22)", color: "#fff", fontFamily: "var(--mono)", fontSize: 10, lineHeight: "14px", padding: "1px 5px", borderRadius: 6, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 5, backdropFilter: "blur(6px)" }}>{fmtTime(seekHint.t)}</span>
                )}
                <input ref={seekRef} type="range" tabIndex={-1} min={0} max={duration || 0} step="any" defaultValue={0} onChange={(e)=> { const v=parseFloat(e.target.value); if(!videoRef.current) return; if (isDraggingRef.current) { animRef.current = null; pendingSeekRef.current = null; videoRef.current.currentTime = v; setCurrent(v); } else { seekTo(v); } }} onPointerDown={(e)=>{ pressedRef.current = true; isDraggingRef.current = false; pressStartRef.current = { x: e.clientX, y: e.clientY }; showSeekHint(e); }} onPointerMove={(e)=>{ showSeekHint(e); if (pressedRef.current) { const dx = e.clientX - pressStartRef.current.x; const dy = e.clientY - pressStartRef.current.y; if (Math.hypot(dx, dy) > 4) isDraggingRef.current = true; } }} onPointerLeave={()=>{ setSeekHint(null); }} onPointerUp={(e)=>{ pressedRef.current = false; isDraggingRef.current = false; const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right) setSeekHint(null); }} onPointerCancel={()=>{ pressedRef.current = false; isDraggingRef.current = false; setSeekHint(null); }} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} onBlur={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} style={{ flex: 1, width: "100%", accentColor: "#6366f1", height: 4 }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(duration)}</span>
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={toggleFullscreen} title="Fullscreen" style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrows-fullscreen" /></button>
            </div>
          )}
          <div className="fv-speed" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="badge text-bg-primary" style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 6px" }}>{rate.toFixed(1)}×</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
              <input type="range" tabIndex={-1} min="0.1" max="1" step="0.1" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} style={{ width: 90, accentColor: "#6366f1", height: 4 }} />
            </div>
            <div style={{ position: "relative", display: "flex", gap: 3, alignItems: "center", border: "1px solid var(--border)", borderRadius: 6, padding: 2, background: "var(--surface-2)" }}>
              <span className="btn-kbd-hint">E</span>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(false)} className={`btn btn-sm ${!seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 second (←/→)">1s</button>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(true)} className={`btn btn-sm ${seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 frame (~33ms)">1f</button>
            </div>
            <span style={{ flex: 1 }} />
            {(isVideo || gifAsVideoEff) && (
              <button type="button" tabIndex={-1} className={`btn btn-sm ${tracking ? "btn-primary" : "btn-outline-secondary"}`} onClick={() => cycleTracking()} title={tracking ? `${trackBg ? "BG tracking" : "FG tracking"} on (⇧T switches mode) — click to stop and reset` : `Stabilization off — click to start ${trackPrefRef.current === "bg" ? "BG tracking" : "FG tracking"}`} style={{ position: "relative", padding: "4px 8px", fontSize: 11 }}><span className="btn-kbd-hint">⇧T</span><i className="bi bi-camera-video" /> {tracking ? (trackBg ? "BG tracking" : "FG tracking") : "Track"}</button>
            )}
            {(isImage || isVideo || gifAsVideoEff) && (
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={rotateFile} title={`Rotate 90° (⇧R)` + (rotate ? ` · now ${rotate}°` : "")} style={{ position: "relative", padding: "4px 8px", fontSize: 11 }}><span className="btn-kbd-hint">⇧R</span><i className="bi bi-arrow-clockwise" /> Rotate</button>
            )}
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={cycleEndMode} title={`End mode: ${endMode} (r)`} style={{ position: "relative", padding: "4px 6px", fontSize: 11, minWidth: 52, borderRadius: 6, border: "1px solid " + (endMode !== "none" ? "transparent" : "var(--border)"), background: endMode === "next" ? "#6366f1" : endMode === "repeat" ? "#10b981" : endMode === "random" ? "#8b5cf6" : "var(--surface-2)", color: endMode !== "none" ? "#fff" : "var(--muted)" }}>
              <span className="btn-kbd-hint">R</span>
              <i className={`bi ${endMode === "next" ? "bi-skip-forward-fill" : endMode === "repeat" ? "bi-repeat" : endMode === "random" ? "bi-shuffle" : "bi-arrow-repeat"}`} /> {endMode === "next" ? "Next" : endMode === "repeat" ? "Loop" : endMode === "random" ? "Shuffle" : "End"}
            </button>
          {(isVideo || isAudio || gifAsVideoEff) && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {(isVideo || isAudio || gifAsVideoEff) && (
                  <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute (m)" : "Mute (m)"} style={{ position: "relative", color: muted ? "#f87171" : undefined, minWidth: 36, padding: "4px 6px", fontSize: 11 }}><span className="btn-kbd-hint">M</span><i className={`bi ${muted ? "bi-volume-mute-fill" : "bi-volume-up-fill"}`} /></button>
                )}
                <button type="button" tabIndex={-1} className="btn btn-sm btn-primary" onClick={() => { if (!videoRef.current) return; if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); videoRef.current?.focus(); }} style={{ position: "relative", padding: "4px 8px", fontSize: 11 }}>
                  <span className="btn-kbd-hint">Space</span>
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
