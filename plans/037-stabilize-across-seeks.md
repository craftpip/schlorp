# 037 — Stabilization survives seeking (1f and 1s, both directions)

> Project: **xdl** — web UI (`web/src/`, React). Core change is `web/src/components/FileViewer.jsx`.
> Date: 2026-09-26. Status: **Done — implemented, built, verified** (see §8).
> Scope: while stabilization (subject tracking or BG tracking) is running, a seek must not break it — not in **1f** (per-frame) mode, not in **1s** mode, not backwards, not forwards, and not while holding the key (jog). Every seek path re-arms the tracker on the frame it lands on, so the picture comes back stabilized on the very first rendered frame instead of lurching, freezing, or reporting "tracking lost".

---

## 1. Objective

Today `seeked` does one thing: `st.recapture = true`. The next tracking tick re-captures the template and the grid **at the point the subject used to be**, which is a different piece of picture after any real jump, and the velocity of that mismatch is thrown into the compensation. Stabilization therefore does not come back on its own: the point latches onto a patch of background (subject mode) or the compensation runs away from the subject (BG mode), and only the existing slow `identitySearch` re-acquisition — a full-frame sweep that runs **only while already lost** — can rescue it, one miss at a time.

The tracker has everything it needs to re-arm properly (`identitySearch` and the already-present recapture blocks), but they are only reached on the slow lost-path. The fix is a re-**acquire** state that a seek enters immediately.

## 2. What the seek paths are

All of them go through `v.currentTime`, all of them fire `seeked`, and all of them must behave identically:

| Path | Step | Notes |
|------|------|-------|
| `←` / `→` (**1s** mode) | ±1 s | single seek |
| `←` / `→` (**1f** mode) | ±1/30 s | **jog**: an interval of up to 30 steps at `33 / rate` ms, video paused; a `seeked` per step |
| `⇧←` / `⇧→` | ±5 s | coarse seek |
| `⇧+wheel` | ±1 s / ±1/30 s (`seekFrames`) | wheel branch of `handleWheel` |
| horizontal drag on the stage | ±`dx * 0.06` s, or ±1 frame per 8 px in 1f mode | per-step during the drag |
| seekbar (`<input type=range>`) | continuous | a `seeked` per pointer move |
| touch drag on the seekbar | continuous | same |
| loop restart (`r` → Loop) | `seekTo(0)` | deliberate, existing handling stays |

`1s`/`1f` is the `seekFrames` state, toggled by the two buttons in `.fv-speed` and by **E**, persisted in `localStorage` (`xdl_viewer_seekFrames`). Both modes and both directions go through the same `seeked` event, so one re-arm path covers all of them.

## 3. What happens today (root causes)

1. **The wrong frame is measured.** `st.fx/fy` is where the subject *was*. After a seek the new frame is somewhere else entirely, so `captureTemplate`/`subjectFingerprint` at `(fx, fy)` describe a patch of whatever is now there.
2. **A seek is read as camera motion.** In BG mode the recapture zeroes `bgVX/bgVY` but keeps `bgX/bgY`, which were the compensation *for the old shot*. The first tick after the seek therefore shows the whole displacement between the two shots as camera motion, and it is integrated into the compensation.
3. **The tracking loop skips the frame the viewer shows.** `trackingTick` bails at `if (!st.rvfc && v.currentTime === st.tTime)`. With `requestVideoFrameCallback` that guard is skipped, but Chrome only delivers a new-frame callback *after* the frame is composited, so the picture the user sees right after a seek is the untransformed one. The old `bgX/bgY` are still on screen for those frames.
4. **Re-acquisition is only reachable from the lost path.** `identitySearch` runs only in the `st.lost` branch, which needs 10 consecutive misses first.
5. **Consecutive seeks.** In 1f mode and while dragging the seekbar, `seeked` fires every ~33 ms. Whatever the re-arm does has to be cheap and has to survive being interrupted by the next one.

## 4. Desired behavior

- A seek **never** leaves the viewer showing an unstabilized frame: the view transform for the landed frame is computed before the next paint.
- After a seek the subject is re-identified **by identity** in one step, not after ten misses. It is adopted only if the identity gate accepts it, so a seek onto unrelated footage leaves the tracker honest ("tracking lost") instead of inventing a subject.
- The old shot's compensation is **discarded** at the seek boundary, in both modes, in both directions. A one-second step forward and a one-second step backward are the same event as far as the tracker is concerned.
- The user's pan offset and the zoom are kept — the seek moves the playhead, it is not a reset (this is what the `repeat` end-mode path already assumes).
- A re-acquisition failure never reopens the window onto a stranger (the `TRACK_REACQ_KEEP` bar stays in force).
- Nothing changes for an unstabilized viewer, and nothing changes for a viewer that is not tracking.

## 5. Implementation (all in `web/src/components/FileViewer.jsx`)

### 5.1 `onSeeked` becomes a re-arm

Both tracking states wire `onSeeked` to a new `rearmTracking()` helper:

```js
const rearmTracking = () => {
  const st = trackStateRef.current;
  if (!st) return;
  st.seeking = true;
  st.acArmed = false; st.acHold = TRACK_AUTOCENTER_HOLD; st.acRamp = 0;
  if (st.mode === "bg") { st.bgX = 0; st.bgY = 0; st.bgVX = 0; st.bgVY = 0; st.bgRegrab = true; }
  else { st.fx = -1; st.fy = -1; st.vx = 0; st.vy = 0; st.misses = TRACK_BG_MISS; st.lost = true; }
};
```

`fx = -1` is the "position unknown" marker (a real point is `clamp(..., 0, rw-1)`, so `-1` cannot collide). `misses = TRACK_BG_MISS` is what makes the existing lost branch — and with it `identitySearch` — run on the very next tick instead of after ten misses. The *badge* is deliberately not raised here: the tick resolves it within a frame, and a flash of "Tracking lost" on every jog step would be noise.

### 5.2 BG mode discards the old compensation and re-grabs the grid

The re-arm zeroes `bgX/bgY` alongside the velocities: the compensation is what carries the view in BG mode, so carrying the old shot's displacement into the new one (root cause 2) is what used to shove the frame sideways and stay shoved.

Zeroing is not enough on its own. A BG tracker measures *grid* displacement, and after a seek the grid describes frames that are no longer on screen, so the first post-seek ticks measure the old grid against the new picture: the compensation is wrong, and once the misses pile up the whole grid is declared lost and never recovers. The re-arm therefore also raises `bgRegrab`, which the BG branch consumes on the landed frame, before any matching:

```js
if (st.bgRegrab) {
  st.bgRegrab = false;
  refreshGrid(img, st);
  st.gridRW = st.rw; st.gridRH = st.rh;
  st.bgX = 0; st.bgY = 0; st.bgVX = 0; st.bgVY = 0;
  st.warm = 3; st.misses = 0;
  if (st.lost) { st.lost = false; setTrackLost(false); }
}
```

`warm = 3` is the same warm-up the grid already gets when the capture size changes: the grid is rebuilt for three ticks and no compensation is adopted from it, so the shot's own motion is never mistaken for camera shake. `misses = 0` and the badge reset are honest here — unlike the subject branch, BG re-acquisition *is* immediate, because the grid is rebuilt from the frame that is on screen.

### 5.3 The tick runs the instant the frame is replaced

The `currentTime` guard exists so a paused/rVFC-less loop does no work. It is bypassed while `st.seeking` is set, which is exactly the window where the picture is about to change (root cause 3):

```js
if (!st.seeking && !st.rvfc && v.currentTime === st.tTime) return;
st.seeking = false;
```

The flag is consumed on the first tick that runs after the seek, so a jog that fires a `seeked` every 33 ms is not starved: each `seeked` re-sets it, each tick clears it.

`subject mode`: `st.lost` is already true, so the existing lost branch sweeps the frame (with `stick = 0`, so distance cannot outrank quality) and adopts the subject if the identity gate accepts it; on failure it stays lost and the next frame sweeps again. On adoption the existing `wasLost` path re-captures the template, updates the fingerprint, re-captures the grid and zeroes the velocity, so the re-acquisition is a full re-identification rather than a re-anchor on whatever is there.

`bg mode`: `lost` is false and `bgRegrab` is set, so the tick re-grabs the grid from the landed frame and spends three ticks warming it (§5.2) before it measures the new shot. The compensation adopted after that belongs to the new shot, not the old one.

### 5.4 The lost badge stays honest

The subject branch declares a point lost only after ten misses, and both miss paths were guarded by `!st.lost`, so a point that arrived **already** lost — which is exactly what a seek does — could never raise the badge and would sit there reporting "tracking smoothness" forever on footage that no longer contains the subject. Both miss paths now set `st.lost` on the count and set the badge on `st.lost`, which is a no-op re-set while genuinely lost (same value, React bails out) and the honest answer when a seek lands where the subject is not.

### 5.5 The `recapture` flag goes away — and its BG half comes back

`st.recapture` had exactly one setter: the old `onSeeked`. With the re-arm replacing it, the flag is unreachable and the *subject* consumer was actively wrong — it re-fingerprinted whatever sat at the **old** point, i.e. it locked a patch of background in as "the subject". That block is removed for good.

The BG consumer was a different matter: it was the only place that rebuilt the grid on a seek, and `seeking` alone does not rebuild anything (it only makes the tick run). Deleting it with the subject block is what turned "BG tracking goes lost after a seek" from *intermittent* into *reproducible* — measured, see §8. Its job now belongs to `bgRegrab` (§5.2), which does it on the landed frame for the same reason and without the stale-fingerprint half.

Re-capture therefore happens where it is meaningful: on a successful subject re-acquisition (`wasLost`), on a resize, on the periodic grid refresh, and — for the grid only — on a seek.

### 5.6 Auto-center

Auto-center's home spring for the BG compensation parks at zero and re-arms its countdown; the view also has to come back to the middle from wherever the old shot left it. Both are re-armed on every seek.

### 5.7 Deliberate seeks keep their explicit handling

`repeat` end mode (`seekTo(0)` + `recenterView()`) and `applyTrackPref` (which re-captures from scratch when tracking starts) are unchanged; a re-arm on top of them is a no-op because they zero the same state.

### 5.8 Files touched

| File | Change |
|------|--------|
| `web/src/components/FileViewer.jsx` | `rearmTracking()` helper, both `onSeeked` handlers rewired, `seeking` flag in both states and consumed in the tick guard, `bgRegrab` flag in the BG state and consumed at the top of the BG branch (grid re-grab + `warm`), `recapture` flag and its two dead blocks removed, lost-badge fix in the two subject miss paths |
| `plans/037-stabilize-across-seeks.md` | this plan |

No API, no server, no new UI, no new shortcut, no other file.

## 6. Decisions

- **Re-acquire, do not re-capture at the old point.** Keeping the old point would be one frame cheaper but locks a patch of background in as "the subject", which is the failure mode §1 of the header comment on `TRACK_DESC` exists to prevent.
- **Keep the identity gate.** If the subject is not in the landed frame, the honest answer is "lost", not a re-anchor on whatever moved. Both directions therefore behave identically: a backward seek can only be stabilized if the subject is there to be found.
- **User pan and zoom survive a seek.** `offX/offY` and the zoom are the user's, not the shot's; only the tracked part (`bgX/bgY`, or the subject position) is discarded.
- **No extra UI.** The pill, the buttons and the shortcuts are unchanged. If a seek lands somewhere the subject is not, the existing "Tracking lost" text already says so.
- **1f vs 1s needs no separate code.** Both fire `seeked` per step; the only difference is how often, which the cheapness of the re-arm covers.
- **Out of scope:** making the tracker survive a seek onto *unrelated* footage (impossible without re-identification, which would be a different feature); any change to the non-tracking seek path; anything on the server.

## 7. Implementation steps

1. Add `rearmTracking()` next to the other tracking helpers and rewire both `onSeeked` handlers to it.
2. Add `seeking` to both tracking states and consume it in the `trackingTick` guard.
3. Drop the `recapture` flag and its two now-unreachable blocks.
4. Add `bgRegrab`: set by the re-arm, consumed at the top of the BG branch (grid re-grab, `warm = 3`, miss reset).
5. Raise the lost badge from the subject miss paths when the point arrived already lost.
6. Build + lint.
7. Verify (§8) on the live app, both modes, both directions, 1f/1s, ±5 s, held jog, seekbar, zoom survival.

## 8. Verification

### 8.1 Build and lint

```bash
cd web && npm run build     # dist/assets/index-BQFIslcg.js (+ .map)
cd web && npm run lint      # oxlint — no new warnings (3 pre-existing FileViewer unused-var warnings only)
```

### 8.2 Automated matrix against the served app

`/tmp/opencode/matrix2.cjs` drives the real app in the container's own headless Chromium (`--disable-dev-shm-usage`, 390×844, remote debugging on `9333`) over CDP. **One fresh page per case**, so a paused video, a leftover 1f toggle or a drifted view from an earlier case cannot contaminate the next one. A tracking point is set the way a user sets one — hold `Shift`, click the point, release `Shift` (`handleStageClick` only arms while `Shift` is held; a bare click does not arm). Each case first samples a 2.5 s no-seek baseline and is **skipped unless the second half of it is lost-free**, so a seek result can never be read off an already-broken baseline. Then the seek happens and the view is sampled for 1.6 s at 50 ms: pill text, video `transform` (translate/scale), the dot's offset, `currentTime`, `paused`, NaN.

```bash
node /tmp/opencode/matrix2.cjs "<label>" cosplay2 <clip>.mp4
```

`playground: cosplay2`, clips `neneko.n-dq1inqygbum.mp4` (33.6 s) and `toxicosplay-dvzftqudbi7.mp4` (11.8 s).

Result on the final build — 14/14 cases pass, subject mode:

| case | n | lost | first smooth | max jump | verdict |
|------|---|------|--------------|----------|---------|
| baseline (no seek) | 31 | 0 | 62 ms | 1.2 px | ok |
| 1s forward | 31 | 0 | 108 ms | 4.8 px | ok |
| 1s back | 26 | 0 | 67 ms | 12.6 px | ok |
| 5s forward (`⇧→`) | 32 | 0 | 69 ms | 30.8 px | ok |
| 5s back (`⇧←`) | 29 | 0 | 155 ms | 60.0 px | ok |
| 1f single step fwd | 25 | 0 | 104 ms | 30.3 px | ok |
| 1f single step back | 31 | 0 | 53 ms | 11.1 px | ok |
| 1f held jog fwd | 31 | 0 | 54 ms | 3.5 px | ok |
| seekbar click 75 % | 21 | 1 (50 ms) | 84 ms | 107.9 px | ok |
| BG 1s forward | 28 | 0 | 142 ms | 0.4 px | ok |
| BG 1s back | 22 | 0 | 108 ms | 0.3 px | ok |
| BG jump to 7.0 | 26 | 0 | 93 ms | 0.2 px | ok |
| zoom 2.87× then 1s seek | 31 | 0 | 56 ms | 46.8 px | ok — `scale(2.87485)` identical before and after |

Reading: after every seek the tracker is back to "tracking smoothness" in 50–155 ms, the compensation is live (never frozen, never `NaN`), and the user's zoom is untouched. The `max jump` column is the size of the *re-centring* move the view has to make when a 1 s / 5 s seek lands the subject somewhere else — it is a property of the cut, not of the tracker (the baseline is 1.2 px).

### 8.3 The A/B that decided it

The same matrix, `onSeeked` re-arm disabled (`if (trackStateRef.current && false)`), on `toxicosplay` — the clip that exposes the defect:

| case | re-arm off | re-arm on (final) |
|------|-----------|------------------|
| BG 1s forward | **FAIL — lost 26/26 (1128 ms)** | ok — lost 0, smooth at 77 ms |
| BG 1s back | ok | ok |
| BG jump to 7.0 | ok | ok |
| all 9 subject cases | ok | ok |

So the reproducible defect this plan fixes is **BG mode**: a seek left the old grid measuring the new picture and the tracker went `lost` and stayed there. The subject-side re-arm is defensive rather than a measured fix on these clips — see §8.4.

### 8.4 What was *not* a seek bug

An early shared-page harness reported "100 % lost on every subject seek with the re-arm off". It does not reproduce with one page per case. The cause was the arming gesture, not the seek: that harness armed by `⇧T` from BG mode, which arms the point at the **centre** of the frame, and on `toxicosplay` the centre is a weak patch — the same centre arm is unsteady *during plain playback, with no seeking at all* (`ARM='[[0.5,0.5]]'`: baseline tail lost 7/16, 9/17, 12/18 … across cases). A bad arm point is a pre-existing weakness and is out of scope here; it is called out because it masquerades as a seek bug.

### 8.5 Not verified here

- Subject tracking on a seek that lands where the subject genuinely is not: the negative control (`corner arm + 1s fwd`) is skipped whenever its own baseline is unsteady, so the "does the badge say Tracking lost" case has no clean measurement. The code path is the `st.lost` miss fix in §5.4, exercised by the centre-arm runs above (which do go `lost` and say so).
- `⇧+wheel` seeking: same `seekTo` path as `⇧→`, which is measured.
- Behaviour with stabilization off: untouched by this change (no code outside the tracking state is involved).

