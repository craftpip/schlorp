const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLikelyVideoUrl,
  isAdVideoUrl,
  isPreviewClipUrl,
  isRedgifsUrl,
  extractRedgifsId,
  isRedditMediaUrl,
  isGifUrl,
  isImageUrl,
  isPhotoUrl,
  stripByteRangeParams,
  isStreamingManifestUrl,
  isDirectFileUrl,
  extractQualityHint,
  metadataQualityScore,
  isInstagramAudioOnlyUrl,
  getInstagramAssetId,
  scoreDownloadCandidate,
  prioritizeInstagramCandidates,
  prioritizeRedditCandidates,
  extractDownloadableVideoUrls,
  prioritizeXhamsterCandidates,
  sanitizeFileToken,
} = require("../../scan-videos/media-utils");

function efgUrl(efgObj, url = "https://scontent.cdninstagram.com/v/t51.123/456.mp4") {
  const b64 = Buffer.from(JSON.stringify(efgObj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${url}${url.includes("?") ? "&" : "?"}efg=${b64}`;
}

test("isLikelyVideoUrl: matches known video extensions with optional query", () => {
  assert.equal(isLikelyVideoUrl("https://x.com/v.mp4"), true);
  assert.equal(isLikelyVideoUrl("https://x.com/v.m3u8?range=1-2"), true);
  assert.equal(isLikelyVideoUrl("https://x.com/v.mpd"), true);
  assert.equal(isLikelyVideoUrl("https://x.com/v.webm"), true);
  assert.equal(isLikelyVideoUrl("https://x.com/v.gif"), false);
  assert.equal(isLikelyVideoUrl("https://x.com/v.mp4x"), false);
});

test("isStreamingManifestUrl / isDirectFileUrl", () => {
  assert.equal(isStreamingManifestUrl("https://x/master.m3u8"), true);
  assert.equal(isStreamingManifestUrl("https://x/master.mpd?a=b"), true);
  assert.equal(isStreamingManifestUrl("https://x/v.mp4"), false);
  assert.equal(isDirectFileUrl("https://x/v.mp4"), true);
  assert.equal(isDirectFileUrl("https://x/mov.mov?x=1"), true);
  assert.equal(isDirectFileUrl("https://x/master.m3u8"), false);
});

test("stripByteRangeParams: removes bytestart/byteend, keeps other params", () => {
  assert.equal(
    stripByteRangeParams("https://x/v.mp4?bytestart=0&byteend=100&token=abc"),
    "https://x/v.mp4?token=abc"
  );
  assert.equal(stripByteRangeParams("https://x/v.mp4?bytestart=0&byteend=100"), "https://x/v.mp4");
  assert.equal(stripByteRangeParams("not a url"), "not a url");
});

test("isRedgifsUrl / extractRedgifsId", () => {
  assert.equal(isRedgifsUrl("https://redgifs.com/watch/abc123"), true);
  assert.equal(isRedgifsUrl("https://redgifs.com/ifr/someid?x=1"), true);
  assert.equal(isRedgifsUrl("https://redgifs.com/static/foo.js"), false);
  assert.equal(isRedgifsUrl("https://example.com/watch/abc"), false);
  assert.equal(extractRedgifsId("https://redgifs.com/watch/abc123"), "abc123");
  assert.equal(extractRedgifsId("https://redgifs.com/watch/A1b2C3d4?x=1"), "A1b2C3d4");
  assert.equal(extractRedgifsId("https://example.com/watch/abc"), "");
});

test("isRedditMediaUrl: v.redd.it / i.redd.it / preview / redgifs / external-preview", () => {
  assert.equal(isRedditMediaUrl("https://v.redd.it/abc/DASH_720.mp4"), true);
  assert.equal(isRedditMediaUrl("https://i.redd.it/abc.jpg"), true);
  assert.equal(isRedditMediaUrl("https://preview.redd.it/abc.jpg?w=1080"), true);
  assert.equal(isRedditMediaUrl("https://external-preview.redd.it/abc.jpg"), true);
  assert.equal(isRedditMediaUrl("https://redgifs.com/watch/abc"), true);
  assert.equal(isRedditMediaUrl("https://cdn.example.com/v.mp4"), false);
});

test("isGifUrl / isImageUrl / isPhotoUrl", () => {
  assert.equal(isGifUrl("https://x/a.gif"), true);
  assert.equal(isGifUrl("https://x/a.gif?format=mp4"), true);
  assert.equal(isGifUrl("https://x/a.jpg"), false);
  assert.equal(isImageUrl("https://x/a.jpeg?q=1"), true);
  assert.equal(isImageUrl("https://x/a.png"), true);
  assert.equal(isImageUrl("https://x/a.webp"), true);
  assert.equal(isImageUrl("https://x/a.gif"), false);
  assert.equal(isPhotoUrl("https://x/a.jpg"), true);
});

test("isAdVideoUrl: ad/tracker hosts only", () => {
  assert.equal(isAdVideoUrl("https://ads.adtng.com/v.mp4"), true);
  assert.equal(isAdVideoUrl("https://www.trafficjunky.net/v.mp4"), true);
  assert.equal(isAdVideoUrl("https://trafficjunky.com/v.mp4"), true);
  assert.equal(isAdVideoUrl("https://cdn.example.com/v.mp4"), false);
});

test("isPreviewClipUrl: phncdn pre_videos only", () => {
  assert.equal(isPreviewClipUrl("https://cdn01.phncdn.com/pre_videos/thumb/v.mp4"), true);
  assert.equal(isPreviewClipUrl("https://cdn01.phncdn.com/videos/2023/01/v.mp4"), false);
});

test("extractQualityHint: explicit Np then path segment match", () => {
  assert.equal(extractQualityHint("https://cdn.com/videos/1080p/file.mp4"), 1080);
  assert.equal(extractQualityHint("https://cdn.com/480p.mp4"), 480);
  assert.equal(extractQualityHint("https://cdn.com/videos/720/file.mp4"), 720);
  assert.equal(extractQualityHint("https://cdn.com/live/master.m3u8"), 0);
});

test("metadataQualityScore: golden value with height/width/label/bitrate/fps", () => {
  const score = metadataQualityScore({
    height: 1080,
    width: 1920,
    bitrate: 5_000_000,
    fps: 30,
    label: "1080p",
  });
  assert.equal(score, 2_357_300_000);
});

test("metadataQualityScore: empty/null metadata scores 0", () => {
  assert.equal(metadataQualityScore({}), 0);
  assert.equal(metadataQualityScore(null), 0);
  assert.equal(metadataQualityScore("x"), 0);
});

test("isInstagramAudioOnlyUrl: dash_lna and audio tags true, video tags false", () => {
  assert.equal(isInstagramAudioOnlyUrl(efgUrl({ vencode_tag: "dash_lna_1699_x" })), true);
  assert.equal(isInstagramAudioOnlyUrl(efgUrl({ vencode_tag: "audio_v2" })), true);
  assert.equal(isInstagramAudioOnlyUrl(efgUrl({ vencode_tag: "dash_baseline" })), false);
  assert.equal(isInstagramAudioOnlyUrl("https://x.com/v.mp4"), false);
});

test("getInstagramAssetId: reads xpv_asset_id from efg", () => {
  assert.equal(getInstagramAssetId(efgUrl({ xpv_asset_id: "1792039234engti" })), "1792039234engti");
  assert.equal(getInstagramAssetId(efgUrl({ vencode_tag: "dash_baseline" })), "");
  assert.equal(getInstagramAssetId("https://x.com/v.mp4"), "");
});

test("scoreDownloadCandidate: plain direct mp4 baseline", () => {
  assert.equal(scoreDownloadCandidate("https://x.com/a.mp4"), 450_000);
});

test("scoreDownloadCandidate: quality hint adds 1000 per level", () => {
  assert.equal(scoreDownloadCandidate("https://x.com/1080p/a.mp4"), 450_000 + 1_080_000);
});

test("scoreDownloadCandidate: m3u8 manifest scores 150k", () => {
  assert.equal(scoreDownloadCandidate("https://x.com/master.m3u8"), 150_000);
});

test("scoreDownloadCandidate: efg baseline + bitrate add", () => {
  const url = efgUrl({ vencode_tag: "dash_baseline", bitrate: 1_000_000 });
  assert.equal(scoreDownloadCandidate(url), 2_000 + 1_000_000 + 450_000);
});

test("scoreDownloadCandidate: audio (-20k) ranks below same-URL baseline", () => {
  const audio = scoreDownloadCandidate(efgUrl({ vencode_tag: "dash_lna" }));
  const baseline = scoreDownloadCandidate(efgUrl({ vencode_tag: "dash_baseline" }));
  assert.equal(audio, -20_000 + 450_000);
  assert.ok(audio < baseline);
});

test("scoreDownloadCandidate: metadata bonus passes through", () => {
  assert.equal(scoreDownloadCandidate("https://x.com/a.mp4", 777), 450_000 + 777);
});

test("prioritizeInstagramCandidates: exact dom URL match wins", () => {
  const u1 = "https://cdn.example.com/v/a.mp4";
  const u2 = "https://cdn.example.com/v/b.mp4";
  const ordered = prioritizeInstagramCandidates([u1, u2], [u1]);
  assert.deepEqual(ordered, [u1, u2]);
});

test("prioritizeInstagramCandidates: byte-range variant of dom URL still matches", () => {
  const u1 = "https://cdn.example.com/v/a.mp4";
  const u2 = "https://cdn.example.com/v/b.mp4";
  const ordered = prioritizeInstagramCandidates([u1, u2], [u1 + "?bytestart=0&byteend=100"]);
  assert.deepEqual(ordered, [u1, u2]);
});

test("prioritizeInstagramCandidates: shared efg asset id gets +40M bonus", () => {
  const asset = { xpv_asset_id: "abc123" };
  const candidate = efgUrl(asset, "https://cdn.example.com/v/a.mp4");
  const domUrl = efgUrl(asset, "https://cdn.example.com/v/other.mp4");
  const other = "https://cdn.example.com/v/b.mp4";
  const ordered = prioritizeInstagramCandidates([candidate, other], [domUrl]);
  assert.deepEqual(ordered, [candidate, other]);
});

test("extractDownloadableVideoUrls: filters blob/ads/previews/non-video and dedupes", () => {
  const input = [
    "blob:https://x/abc",
    "https://x.com/a.mp4",
    "https://x.com/a.mp4?bytestart=0&byteend=100",
    "https://ads.adtng.com/ad.mp4",
    "https://cdn01.phncdn.com/pre_videos/thumb/pv.mp4",
    "https://x.com/photo.jpg",
    "https://x.com/b.mp4",
  ];
  const out = extractDownloadableVideoUrls(input);
  assert.deepEqual(out, ["https://x.com/a.mp4", "https://x.com/b.mp4"]);
});

test("extractDownloadableVideoUrls: qualityByUrl metadata reorders by score", () => {
  const a = "https://x.com/a.mp4";
  const b = "https://x.com/b.mp4";
  const q = new Map([[b, 500]]);
  const out = extractDownloadableVideoUrls([a, b], { qualityByUrl: q });
  assert.deepEqual(out, [b, a]);
});

test("extractDownloadableVideoUrls: forceInclude bypasses ad filter", () => {
  const ad = "https://ads.adtng.com/ad.mp4";
  const out = extractDownloadableVideoUrls([ad], { forceIncludeUrls: new Set([ad]) });
  assert.deepEqual(out, [ad]);
});

test("prioritizeXhamsterCandidates: manifests first, then highest-quality direct", () => {
  const urls = ["https://x.com/low.mp4", "https://x.com/high-720.mp4", "https://x.com/master.m3u8"];
  assert.deepEqual(prioritizeXhamsterCandidates(urls), [
    "https://x.com/master.m3u8",
    "https://x.com/high-720.mp4",
    "https://x.com/low.mp4",
  ]);
});

test("sanitizeFileToken: lowercases, dashes invalid, trims, caps at 64", () => {
  assert.equal(sanitizeFileToken("  My Video 1080p!  "), "my-video-1080p");
  assert.equal(sanitizeFileToken("---x---"), "x");
  assert.equal(sanitizeFileToken("file.name_v2"), "file.name_v2");
  const long = sanitizeFileToken("a".repeat(100));
  assert.equal(long.length, 64);
});

test("prioritizeRedditCandidates: true-video post prefers v.redd.it over preview", () => {
  const urls = [
    "https://preview.redd.it/abc.gif?format=mp4",
    "https://i.redd.it/abc.gif",
    "https://v.redd.it/abc/DASH_720.mp4",
  ];
  const ordered = prioritizeRedditCandidates(urls);
  assert.deepEqual(ordered, [
    "https://v.redd.it/abc/DASH_720.mp4",
    "https://preview.redd.it/abc.gif?format=mp4",
    "https://i.redd.it/abc.gif",
  ]);
});

test("prioritizeRedditCandidates: gif-only post ranks raw GIF above mp4 preview", () => {
  const urls = [
    "https://preview.redd.it/abc.gif?format=mp4",
    "https://i.redd.it/abc.gif",
  ];
  const ordered = prioritizeRedditCandidates(urls);
  assert.deepEqual(ordered, ["https://i.redd.it/abc.gif", "https://preview.redd.it/abc.gif?format=mp4"]);
});

test("prioritizeRedditCandidates: redgifs mp4 above redgifs m3u8", () => {
  const urls = ["https://media.redgifs.com/abc.m3u8", "https://media.redgifs.com/abc.mp4"];
  assert.deepEqual(prioritizeRedditCandidates(urls), ["https://media.redgifs.com/abc.mp4", "https://media.redgifs.com/abc.m3u8"]);
});