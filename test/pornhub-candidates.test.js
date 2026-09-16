const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAdVideoUrl,
  extractDownloadableVideoUrls,
} = require("../scan-videos/media-utils");
const { expandPornhubGetMediaUrls } = require("../scan-videos/extractors");

const ADS = [
  "https://ht-cdn2.adtng.com/a7/creatives/221/1559/819327/1194411/1194411_video.mp4",
  "https://ht-cdn2.adtng.com/a7/creatives/221/1559/824990/1175273/1175273_video.mp4",
  "https://ht-cdn.trafficjunky.net/c6321/video/003/285/151/3285151_video.mp4",
];

const HLS_1080 =
  "https://ev-h.phncdn.com/hls/videos/202405/19/452672291/1080P_4000K_452672291.mp4/master.m3u8?validfrom=1789497089&validto=1789504289&hash=AAA";
const HLS_720 =
  "https://ev-h.phncdn.com/hls/videos/202405/19/452672291/720P_4000K_452672291.mp4/master.m3u8?validfrom=1789497089&validto=1789504289&hash=BBB";
const GET_MEDIA =
  "https://www.pornhub.org/video/get_media?s=abc&v=6649f33a3f178&e=0&t=p";

test("ad creative hosts are detected, player/CDN hosts are not", () => {
  for (const url of ADS) assert.equal(isAdVideoUrl(url), true, url);
  assert.equal(isAdVideoUrl(HLS_1080), false);
  assert.equal(isAdVideoUrl(GET_MEDIA), false);
  assert.equal(
    isAdVideoUrl("https://ev.phncdn.com/videos/202405/19/452672291/480P_2000K_452672291.mp4?x=1"),
    false
  );
  assert.equal(isAdVideoUrl("not a url"), false);
});

test("ad mp4s never survive candidate filtering (wrong-video guard)", () => {
  const out = extractDownloadableVideoUrls([HLS_1080, HLS_720, ...ADS]);
  assert.deepEqual(out, [HLS_1080, HLS_720]);
});

test("extensionless get_media stays out, expanded direct mp4s stay in", () => {
  const expandedMp4 =
    "https://ev.phncdn.com/videos/202405/19/452672291/480P_2000K_452672291.mp4?validfrom=1789497275&hash=CCC";
  const out = extractDownloadableVideoUrls([HLS_1080, GET_MEDIA, expandedMp4, ...ADS]);
  assert.ok(!out.includes(GET_MEDIA), "raw get_media has no file extension");
  assert.ok(out.includes(HLS_1080), "main HLS kept");
  assert.ok(out.includes(expandedMp4), "resolved direct mp4 kept");
  assert.equal(out[0], HLS_1080, "main 1080p HLS ranks first");
  assert.ok(!out.some(isAdVideoUrl), "no ad URL in output");
});

test("expandPornhubGetMediaUrls resolves direct mp4s with quality metadata", async () => {
  const direct480 =
    "https://ev.phncdn.com/videos/202405/19/452672291/480P_2000K_452672291.mp4?validfrom=1&hash=x";
  const direct240 =
    "https://ev.phncdn.com/videos/202405/19/452672291/240P_1000K_452672291.mp4?validfrom=1&hash=y";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { height: 480, width: 854, defaultQuality: true, format: "mp4", videoUrl: direct480, quality: "480" },
      { height: 240, width: 426, defaultQuality: false, format: "mp4", videoUrl: direct240, quality: "240" },
    ],
  });
  // Fake page: run the evaluate callback inline like a real browser would.
  const fakePage = { evaluate: (fn, arg) => fn(arg) };
  try {
    const expanded = await expandPornhubGetMediaUrls(fakePage, [GET_MEDIA, HLS_1080]);
    assert.deepEqual(expanded.urls, [direct480, direct240]);
    assert.ok(expanded.qualityByUrl.get(direct480) > expanded.qualityByUrl.get(direct240));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("expandPornhubGetMediaUrls ignores non-target pages without get_media", async () => {
  const fakePage = {
    evaluate: () => {
      throw new Error("must not fetch when no get_media URL is present");
    },
  };
  const expanded = await expandPornhubGetMediaUrls(fakePage, [HLS_1080]);
  assert.deepEqual(expanded.urls, []);
});
