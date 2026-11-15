# Plan 039 — Encrypted media (lock/unlock) + uploads in the Media panel

**Date:** 2026-11-15
**Status:** Implemented (2026-11-15) — verified with unit tests + live API/UI smoke test on a scratch copy
**Trigger:** User: "the media already listed will be listed with a unlock sign, i should be able to
individually lock a file or lock full folder from the context menu. the app will have a global setting
to encrypt new files, will be available when panel password is set. also add feature to upload files in
media panel, add upload button, i should be able to drag drop items in there"
**Project:** **xdl** — `api-server.js`, new `scan-videos/media-crypto.js`, `scan-videos/download.js`
(poster input override), web `Media.jsx`, `MediaContextMenu.jsx`, new `MediaTasksPanel.jsx`.

## 1. Goals

1. Files at rest on the media drive can be **encrypted** (AES-256-GCM). An encrypted file copied off the
   disk does not open in any player; it plays only through the Media panel (server decrypts on the fly).
2. Every file tile/row shows a padlock: open padlock = plain, closed padlock = encrypted.
3. Context menu: **Lock / Unlock** selected file(s); **Lock folder / Unlock folder** (recursive) on a folder
   chip or on empty grid space (= current folder).
4. Global setting `ENCRYPT_NEW_MEDIA` (Settings → Encryption): new downloads and uploads are encrypted
   automatically. Only allowed while a panel password is set.
5. **Upload** button in the Media toolbar + drag-and-drop of files/folders from the OS onto the panel,
   with a progress panel.

## 2. Design

### 2.1 Same filename, encrypted bytes
An encrypted file keeps its exact name (`clip.mp4` stays `clip.mp4`). Detection is by magic header.
So playlists, stacks, custom order, move, delete, rename and poster siblings keep working untouched.
File names stay visible (accepted trade-off; content is what's protected).

### 2.2 File format (`XDLENC01`)
```
header (40 B): magic "XDLENC01"(8) | salt(16) | chunkSize u32 BE(4) | createdMs u64 BE(8) | reserved(4)
body: N chunks, each = AES-256-GCM(plain[i]) (≤ chunkSize) + tag(16); N ≥ 1 (empty file → 1 empty chunk)
fileKey = HKDF-SHA256(masterKey, salt, "xdl-media-v1")
nonce_i = 8 zero bytes | u32 BE i
AAD_i   = salt | u32 BE i | isLast(1 B)
```
- Chunked → random access: HTTP Range / video seeking decrypts only the touched 64 KiB chunks.
- `isLast` in AAD detects truncation; index in nonce/AAD detects reordering.
- Plain size is derived from the file size (`body - N*16`), so encryption can stream (uploads).
- `createdMs` preserves the original creation time (the encrypt rename makes a new inode); mtime is
  restored with `utimes`, so gallery sort order does not move.

### 2.3 Key management (vault)
- Random 32-byte **master key**, wrapped with `scrypt(panelPassword, N=2^17, r=8, p=1)` + AES-256-GCM,
  stored at `media/.xdl-vault.json` (travels with the media → recoverable with the password alone).
- Server unwraps at startup with `UI_PANEL_PASSWORD`; created lazily on the first lock / when
  `ENCRYPT_NEW_MEDIA` is turned on.
- Changing the panel password in Settings re-wraps the master key. Clearing the password is refused while a
  vault exists. If `.env` was edited by hand and unwrap fails, `POST /api/vault/unlock {password}` unwraps
  with the old password and re-wraps with the current one.
- Known limit: `.env` holds the panel password in plain text, so whoever has the app folder **and** the
  media drive can decrypt. The media drive alone (stolen/copied) is protected.

### 2.4 Serving & ffmpeg
- `/media/*` middleware before `express.static`: encrypted → decrypt-stream with Range support, correct
  MIME (incl. the gif→mp4 sniff), `Cache-Control: private, no-store`. Key missing → 423.
- Server-side ffmpeg/ffprobe on encrypted files (dims probe, embedded thumbs, poster generation) reads
  through `http://127.0.0.1:<port>/media/...` with a per-process random `X-Xdl-Internal` token (loopback only).
- Embedded thumbs for encrypted videos are cached **in memory only** (no plaintext in `/tmp`). `/api/gifvideo`
  for an encrypted gif → 404 (viewer falls back to the decrypted gif itself).
- Locking a file also locks its `<stem>-poster.*` siblings and drops stale plaintext thumb/gif caches.

### 2.5 Jobs
- `POST /api/media/lock {action, folder, keys[], dirs[]}` → one background job at a time (encrypt/decrypt
  via temp file + atomic rename). `GET /api/media/lock/job` for progress; also WS `lock:progress`.
- Skips dotfiles, `.xdlstack`, `.part/.tmp/.ytdl` partials, already-locked (lock) / plain (unlock).
- Downloads (`/download` + web queue): when `ENCRYPT_NEW_MEDIA=1`, every `Downloaded media to:` path
  (+ poster) is locked after the job finishes.

### 2.6 Upload
- `POST /api/media/upload?folder=&path=` with the raw file body (no new dependency, streams any size).
  `path` may contain sub-folders (folder drops); each segment sanitized, contained in media, collision →
  `name (1).ext`. Streams straight into the encrypted format when `ENCRYPT_NEW_MEDIA=1`. Video uploads get a
  poster in the background.
- UI: toolbar **Upload** button (file picker), drop overlay on the panel for OS file/folder drags, bottom-right
  tasks panel (per-file progress, cancel), listing refresh as files land.

## 3. Out of scope / follow-ups
- Encrypting file names. Folder "stay locked" policy for files moved in later (global setting covers new files).
- Secure wipe of old plaintext blocks (filesystem free space) — documented to the user.

## 4. Tests
- `test/unit/media-crypto.test.js`: round-trip (sizes 0, 1, chunk-1, chunk, chunk+1, multi-chunk), range
  decrypt at arbitrary offsets, tamper/truncate detection, header detection, vault wrap/unwrap/rewrap,
  wrong password, stream-encrypt equals file-encrypt output size, time preservation.

## 5. Revision (2026-11-15) — passphrase-only, key with each drive

User: "encrypt with the string in my mind only" + "keep the key with the drive" (option A).

- Encryption passphrase is separate from the panel login and never stored. X25519 key pair; public key in
  the clear (encrypts new downloads/uploads while locked), private key sealed by scrypt(passphrase), held in
  memory only between unlock and lock/restart.
- File format v2 `XDLENC02` (128-byte header: ephemeral pub, wrapped per-file key, salt, chunk size, created,
  key id). v1 (`XDLENC01`, key wrapped by the panel password) is gone: all v1 files on the real media were
  decrypted by a one-off migration before the switch, the v1 vault deleted.
- Vault copies at the media root and every drive mount root inside media/ (`st.dev` walk).
- No automatic vault creation; setup is explicit (Settings → Encryption, ≥12 chars, "Suggest one" =
  6 random words, no-recovery acknowledgement). Unlock from Settings or the Media page bar; "Lock now".
- Context menu shows "Set up encryption…" until a vault exists.

## 6. Revision 2 (2026-11-15) — one secret: password or pattern

User: "there are two passwords now… use my password/pattern"; chose "Password or pattern" (either opens files from disk).

- Separate encryption passphrase removed. The panel password (≥12 chars for encryption) and an optional 5×5 / ≥8-dot
  pattern each seal a slot of the vault's private key (vault v3). Login with either unlocks the vault.
- Password no longer stored in plain text anywhere: scrypt hash in `.xdl-auth.json`, one-time migration from `.env`;
  the browser keeps a session token instead of the password; header/query password auth removed.
- Soft lock removed: Lock now / idle auto-lock wipe the key; password or pattern re-open it (rate-limited).
- Known trade-off (accepted by the user): a stolen drive is only as safe as the pattern.
