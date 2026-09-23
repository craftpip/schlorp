const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseM3u8Playlist,
  parseM3u8Attributes,
  isImageSegmentUrl,
} = require("../../scan-videos/download");

test("parseM3u8Attributes: quoted + bare values", async () => {
  assert.deepEqual(parseM3u8Attributes('BANDWIDTH=123,RESOLUTION=640x360,CODECS="a,b"'), {
    BANDWIDTH: "123",
    RESOLUTION: "640x360",
    CODECS: "a,b",
  });
});

test("parseM3u8Playlist: master picks best variant", async () => {
  const text = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=426x240',
    "low/video.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720',
    "hi/video.m3u8",
  ].join("\n");
  const parsed = parseM3u8Playlist(text, "https://cdn.x.com/master.m3u8");
  assert.equal(parsed.variantUrl, "https://cdn.x.com/hi/video.m3u8");
});

test("parseM3u8Playlist: media segments + key + map, relative resolved", async () => {
  const text = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.0,",
    "seg0.ts",
    "#EXTINF:6.0,",
    "https://cdn2.x.com/abs.ts?x=1",
  ].join("\n");
  const parsed = parseM3u8Playlist(text, "https://cdn.x.com/hls/list.m3u8");
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].url, "https://cdn.x.com/hls/seg0.ts");
  assert.equal(parsed.segments[1].url, "https://cdn2.x.com/abs.ts?x=1");
  assert.equal(parsed.keyUri, "https://cdn.x.com/hls/key.bin");
  assert.equal(parsed.keyMethod, "AES-128");
  assert.equal(parsed.mapUri, "https://cdn.x.com/hls/init.mp4");
});

test("parseM3u8Playlist: non-playlist flagged", async () => {
  assert.equal(parseM3u8Playlist("<html>nope</html>", "https://x.com/a.m3u8").notPlaylist, true);
  assert.equal(parseM3u8Playlist("", "https://x.com/a.m3u8").notPlaylist, true);
});

test("isImageSegmentUrl: storyboard strips vs video segments", async () => {
  assert.equal(isImageSegmentUrl("https://cdn.x.com/1080p/video0.jpeg"), true);
  assert.equal(isImageSegmentUrl("https://cdn.x.com/seg-12.ts"), false);
  assert.equal(isImageSegmentUrl("https://cdn.x.com/v.m3u8"), false);
});

test("storyboard guard: all-image playlist trips the >50% rule", async () => {
  const text = ["#EXTM3U", "#EXTINF:4.0,", "video0.jpeg", "#EXTINF:4.0,", "video1.jpeg"].join("\n");
  const parsed = parseM3u8Playlist(text, "https://cdn.x.com/1080p/video.m3u8");
  const imageCount = parsed.segments.filter((s) => isImageSegmentUrl(s.url)).length;
  assert.equal(parsed.segments.length, 2);
  assert.ok(imageCount / parsed.segments.length > 0.5);
});
