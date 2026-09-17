const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const { fixtureServer } = require("../helpers/fixture-server");
const { hasFfmpeg, muxVideoAndAudio, mediaHasAudio, downloadMedia } = require("../../scan-videos/download");

function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), "download-test-")); }

function mp4Buffer() {
  const buf = Buffer.alloc(64, 0);
  // ftyp box at offset 4: "ftyp"
  buf.write("ftyp", 4, "latin1");
  buf.write("isom", 8, "latin1");
  return buf;
}

function gif1x1Buffer() {
  // GIF89a header + 1x1 canvas descriptor
  const buf = Buffer.alloc(23);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(1, 6);   // width
  buf.writeUInt16LE(1, 8);   // height
  buf[10] = 0xf7;            // GCT flag
  // GCT entries follow (256 * 3 bytes = 768 bytes); pad rest with zeros
  return buf;
}

function gifPlaceholderBuffer() {
  // Minimal valid 1x1 GIF87a with no global color table
  const buf = Buffer.alloc(35);
  buf.write("GIF87a", 0, "latin1");
  buf.writeUInt16LE(1, 6);
  buf.writeUInt16LE(1, 8);
  buf[10] = 0x00;
  // Trailer
  buf[34] = 0x3b;
  return buf;
}

function jpgBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf;
}

function pngBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf.writeUInt32BE(0x89504e47, 0); // \x89PNG
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  return buf;
}

function webpBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(20, 4);
  buf.write("WEBP", 8, "latin1");
  return buf;
}

function dummyPrefix() {
  return `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

test("hasFfmpeg: returns a boolean", async () => {
  const result = await hasFfmpeg();
  assert.equal(typeof result, "boolean");
});

test("muxVideoAndAudio: throws when ffmpeg unavailable", async () => {
  await assert.rejects(
    () => muxVideoAndAudio("/a.mp4", "/b.m4a", "/c.mp4"),
    (err) => { assert.ok(err instanceof Error); return true; }
  );
});

test("mediaHasAudio: returns false when ffmpeg unavailable", async () => {
  assert.equal(await mediaHasAudio("/a.mp4"), false);
});

test("downloadMedia: happy path mp4 direct download", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(mp4Buffer().length),
    });
    res.end(mp4Buffer());
  });
  try {
    const { filePath, url } = await downloadMedia(`${srv.url}/video.mp4`, out);
    assert.equal(typeof filePath, "string");
    assert.ok(filePath.endsWith(".mp4"), `expected .mp4 extension, got ${filePath}`);
    assert.equal(url, `${srv.url}/video.mp4`);
    assert.ok(await fs.access(filePath).then(() => true), "file should exist");
  } finally {
    await srv.close();
  }
});

test("downloadMedia: content-type override — magic sniff renames gif-ext to mp4", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(mp4Buffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/fake.gif`, out);
    assert.ok(filePath.endsWith(".mp4"), `expected .mp4 after magic sniff, got ${filePath}`);
  } finally {
    await srv.close();
  }
});

test("downloadMedia: extension fallback from URL when no content-type", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(mp4Buffer());
  });
  try {
    // URL has no extension → ext from content-type is "", magic sniff → mp4
    const { filePath } = await downloadMedia(`${srv.url}/media`, out);
    assert.ok(filePath.endsWith(".mp4"), `expected .mp4 from magic sniff, got ${filePath}`);
  } finally {
    await srv.close();
  }
});

test("downloadMedia: content-type mp4 at .webm URL — magic sniff wins", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/webm" });
    res.end(mp4Buffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/clip.webm`, out);
    assert.ok(filePath.endsWith(".mp4"), `expected .mp4 from magic sniff, got ${filePath}`);
  } finally {
    await srv.close();
  }
});

test("downloadMedia: jpg content-type + jpg magic bytes → .jpg", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(jpgBuffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/pic.jpg`, out);
    assert.ok(filePath.endsWith(".jpg"));
  } finally {
    await srv.close();
  }
});

test("downloadMedia: png content-type + png magic bytes → .png", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(pngBuffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/pic.png`, out);
    assert.ok(filePath.endsWith(".png"));
  } finally {
    await srv.close();
  }
});

test("downloadMedia: webp content-type + webp magic → .webp", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/webp" });
    res.end(webpBuffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/pic.webp`, out);
    assert.ok(filePath.endsWith(".webp"));
  } finally {
    await srv.close();
  }
});

test("downloadMedia: 1x1 placeholder GIF rejected as junk", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(gifPlaceholderBuffer());
  });
  try {
    await assert.rejects(
      () => downloadMedia(`${srv.url}/tiny.gif`, out),
      (err) => {
        assert.ok(/placeholder/.test(err.message), `unexpected message: ${err.message}`);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("downloadMedia: HTTP 404 throws with status code", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  try {
    await assert.rejects(
      () => downloadMedia(`${srv.url}/nope.mp4`, out),
      (err) => {
        assert.ok(err.message.includes("404"), `expected 404 in message, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("downloadMedia: HTTP 403 throws with status code", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(403);
    res.end("forbidden");
  });
  try {
    await assert.rejects(
      () => downloadMedia(`${srv.url}/forbidden.mp4`, out),
      (err) => {
        assert.ok(err.message.includes("403"), `expected 403 in message, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("downloadMedia: m3u8 URL throws when ffmpeg unavailable", async () => {
  const out = await tmpDir();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-mpegURL" });
    res.end("#EXTM3U\n");
  });
  try {
    await assert.rejects(
      () => downloadMedia(`${srv.url}/master.m3u8`, out),
      (err) => {
        assert.ok(/ffmpeg is required/.test(err.message), `unexpected message: ${err.message}`);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test("downloadMedia: progress callback called with stage detail", async () => {
  const out = await tmpDir();
  const calls = [];
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": "64" });
    res.end(mp4Buffer());
  });
  try {
    await downloadMedia(`${srv.url}/video.mp4`, out, {}, dummyPrefix(), {
      onProgress: (e) => calls.push({ ...e }),
    });
    const stages = calls.map((c) => c.stage);
    assert.ok(stages.includes("downloading"), `expected 'downloading' stage, got ${JSON.stringify(stages)}`);
  } finally {
    await srv.close();
  }
});

test("downloadMedia: prefix respected in filePath", async () => {
  const out = await tmpDir();
  const prefix = dummyPrefix();
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(mp4Buffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/video.mp4`, out, {}, prefix);
    assert.ok(filePath.includes(prefix), `expected prefix '${prefix}' in filePath '${filePath}'`);
  } finally {
    await srv.close();
  }
});

test("downloadMedia: createOutDir creates missing directory", async () => {
  const out = path.join(await tmpDir(), "nested", "dir");
  const srv = await fixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(mp4Buffer());
  });
  try {
    const { filePath } = await downloadMedia(`${srv.url}/video.mp4`, out);
    assert.ok(await fs.access(filePath).then(() => true), "file should exist in nested dir");
  } finally {
    await srv.close();
  }
});
