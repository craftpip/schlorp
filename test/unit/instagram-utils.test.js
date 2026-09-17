const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakePage } = require("../helpers/make-fake-page");

const {
  isReservedInstagramName,
  extractInstagramShortcode,
  isInstagramReelTargetUrl,
  isInstagramAvatarUrl,
  extractInstagramUsernameFromJsonText,
  extractInstagramUsernameFromSsrScripts,
  extractInstagramMediaHintsFromJsonText,
  extractInstagramImageHintsFromJsonText,
  dedupeInstagramPhotos,
  filterInstagramCandidatesForTarget,
} = require("../../scan-videos/instagram-utils");

function efgUrl(efgObj, url = "https://scontent.cdninstagram.com/v/t51.1/123.mp4") {
  const b64 = Buffer.from(JSON.stringify(efgObj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${url}${url.includes("?") ? "&" : "?"}efg=${b64}`;
}

test("isReservedInstagramName: reserved route names and empty rejected", () => {
  assert.equal(isReservedInstagramName("reel"), true);
  assert.equal(isReservedInstagramName("p"), true);
  assert.equal(isReservedInstagramName("stories"), true);
  assert.equal(isReservedInstagramName("api"), true);
  assert.equal(isReservedInstagramName(""), true);
  assert.equal(isReservedInstagramName("sophiaar.luv"), false);
  assert.equal(isReservedInstagramName("Reel"), true);
});

test("extractInstagramShortcode: p/reel/reels/tv paths", () => {
  assert.equal(extractInstagramShortcode("https://www.instagram.com/p/DdSewIihI-K/"), "DdSewIihI-K");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/reel/DdSewIihI-K"), "DdSewIihI-K");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/reels/DdSewIihI-K/"), "DdSewIihI-K");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/tv/DdSewIihI-K/?t=5"), "DdSewIihI-K");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/username/"), "");
  assert.equal(extractInstagramShortcode("not a url"), "");
});

test("isInstagramReelTargetUrl: reel/tv true, photo false", () => {
  assert.equal(isInstagramReelTargetUrl("https://www.instagram.com/reel/AbC/"), true);
  assert.equal(isInstagramReelTargetUrl("https://www.instagram.com/tv/AbC/"), true);
  assert.equal(isInstagramReelTargetUrl("https://www.instagram.com/p/AbC/"), false);
});

test("isInstagramAvatarUrl: profile efg tag and stp crop detected", () => {
  const avatarEfg = efgUrl({ vencode_tag: "profile_pic_560" });
  assert.equal(isInstagramAvatarUrl(avatarEfg), true);
  assert.equal(
    isInstagramAvatarUrl("https://scontent.cdninstagram.com/v/t51.1/a.jpg?stp=s150x150"),
    true
  );
  assert.equal(
    isInstagramAvatarUrl("https://scontent.cdninstagram.com/v/t51.1/a.jpg?stp=s640x640"),
    false
  );
  assert.equal(isInstagramAvatarUrl("https://scontent.cdninstagram.com/v/t51.1/a.jpg"), false);
});

test("extractInstagramUsernameFromJsonText: nested user node with for(;;) prefix", () => {
  const json = JSON.stringify({
    data: {
      shortcode_media: {
        code: "DdSewIihI-K",
        user: { username: "sophiaar.luv" },
      },
    },
  });
  assert.equal(
    extractInstagramUsernameFromJsonText(`for (;;);${json}`, "DdSewIihI-K"),
    "sophiaar.luv"
  );
});

test("extractInstagramUsernameFromJsonText: xdt_shortcode_media shorthand", () => {
  const json = JSON.stringify({
    data: {
      xdt_shortcode_media: { shortcode: "DdSewIihI-K", owner: { username: "owner.name" } },
    },
  });
  assert.equal(extractInstagramUsernameFromJsonText(json, "DdSewIihI-K"), "owner.name");
});

test("extractInstagramUsernameFromJsonText: reserved username skipped, then empty", () => {
  const json = JSON.stringify({
    data: { xdt_shortcode_media: { code: "DdSewIihI-K", user: { username: "reel" } } },
  });
  assert.equal(extractInstagramUsernameFromJsonText(json, "DdSewIihI-K"), "");
});

test("extractInstagramUsernameFromJsonText: bad input returns empty", () => {
  assert.equal(extractInstagramUsernameFromJsonText("", "abc"), "");
  assert.equal(extractInstagramUsernameFromJsonText("not json", "abc"), "");
  assert.equal(extractInstagramUsernameFromJsonText(JSON.stringify({ a: 1 }), ""), "");
});

test("extractInstagramUsernameFromSsrScripts: finds user in matching script only", async () => {
  const code = "DdSewIihI-K";
  const page = makeFakePage({
    document: {
      querySelectorAll: () => [
        { textContent: `{"rail":true, "code":"OTHER"}` },
        {
          textContent: `window.__a=1; "code":"${code}" near start and then "user": {"username": "sophiaar.luv"} after the code window slice`,
        },
      ],
    },
  });
  assert.equal(await extractInstagramUsernameFromSsrScripts(page, code), "sophiaar.luv");
});

test("extractInstagramUsernameFromSsrScripts: no matching script returns empty", async () => {
  const page = makeFakePage({ document: { querySelectorAll: () => [] } });
  assert.equal(await extractInstagramUsernameFromSsrScripts(page, "NOPE"), "");
});

test("extractInstagramMediaHintsFromJsonText: target video only, foreign rail excluded", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        code: "DdSewIihI-K",
        video_url: "https://scontent.cdninstagram.com/v/t50.128/abc.mp4",
        related_posts: {
          edges: [
            {
              node: {
                code: "FOREIGN9",
                video_url: "https://scontent.cdninstagram.com/v/t50.128/foreign.mp4",
              },
            },
          ],
        },
      },
    },
  });
  const { urls, assetIds } = extractInstagramMediaHintsFromJsonText(raw, "DdSewIihI-K");
  assert.deepEqual(urls, ["https://scontent.cdninstagram.com/v/t50.128/abc.mp4"]);
  assert.deepEqual(assetIds, []);
});

test("extractInstagramMediaHintsFromJsonText: collects all video-url keys + asset ids", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        shortcode: "DdSewIihI-K",
        video_url: "https://scontent.cdninstagram.com/v/t50.1/full.mp4",
        playback_url: "https://scontent.cdninstagram.com/v/t50.1/play.mp4",
        hls_url: "https://scontent.cdninstagram.com/v/t50.1/audio.m3u8",
      },
    },
  });
  const { urls, assetIds } = extractInstagramMediaHintsFromJsonText(raw, "DdSewIihI-K");
  assert.deepEqual(urls, [
    "https://scontent.cdninstagram.com/v/t50.1/full.mp4",
    "https://scontent.cdninstagram.com/v/t50.1/play.mp4",
    "https://scontent.cdninstagram.com/v/t50.1/audio.m3u8",
  ]);
  assert.deepEqual(assetIds, []);
});

test("extractInstagramMediaHintsFromJsonText: photo-only node yields no video urls", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        code: "DdSewIihI-K",
        display_url: "https://scontent.cdninstagram.com/v/t51.1/photo.jpg",
        __typename: "GraphImage",
      },
    },
  });
  const { urls } = extractInstagramMediaHintsFromJsonText(raw, "DdSewIihI-K");
  assert.deepEqual(urls, []);
});

test("extractInstagramMediaHintsFromJsonText: respects 80k scan cap", () => {
  const railNodes = [];
  for (let i = 0; i < 85_000; i++) {
    railNodes.push({ code: `rail_${i}`, video_url: `https://x.com/r${i}.mp4` });
  }
  railNodes.push({ code: "TARGETSHORT", video_url: "https://x.com/target.mp4" });
  const raw = JSON.stringify({ data: { rails: railNodes } });
  const { urls } = extractInstagramMediaHintsFromJsonText(raw, "TARGETSHORT");
  assert.deepEqual(urls, []);
});

test("extractInstagramMediaHintsFromJsonText: invalid/empty input returns empty", () => {
  assert.deepEqual(extractInstagramMediaHintsFromJsonText("", "abc"), { urls: [], assetIds: [] });
  assert.deepEqual(extractInstagramMediaHintsFromJsonText("not json", "abc"), { urls: [], assetIds: [] });
});

test("extractInstagramImageHintsFromJsonText: picks display_url for image post", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        code: "PHOTO123",
        __typename: "GraphImage",
        display_url: "https://scontent.cdninstagram.com/v/t51.1/photo.jpg",
        display_resources: [
          { src: "https://scontent.cdninstagram.com/v/t51.1/photo_s640x640.jpg", config_width: 640 },
          { src: "https://scontent.cdninstagram.com/v/t51.1/photo.jpg", config_width: 1080 },
        ],
      },
    },
  });
  const { imageUrls } = extractInstagramImageHintsFromJsonText(raw, "PHOTO123");
  assert.deepEqual(imageUrls, ["https://scontent.cdninstagram.com/v/t51.1/photo.jpg"]);
});

test("extractInstagramImageHintsFromJsonText: video nodes excluded from photos", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        code: "REEL123",
        media_type: 2,
        display_url: "https://scontent.cdninstagram.com/v/t51.1/cover.jpg",
      },
    },
  });
  const { imageUrls } = extractInstagramImageHintsFromJsonText(raw, "REEL123");
  assert.deepEqual(imageUrls, []);
});

test("extractInstagramImageHintsFromJsonText: sidecar children in order, videos skipped", () => {
  const raw = JSON.stringify({
    data: {
      xdt_shortcode_media: {
        code: "CAR12345",
        __typename: "GraphSidecar",
        edge_sidecar_to_children: {
          edges: [
            { node: { __typename: "GraphImage", display_url: "https://scontent.cdninstagram.com/v/t51.1/1.jpg" } },
            { node: { __typename: "GraphVideo", display_url: "https://scontent.cdninstagram.com/v/t51.1/2.jpg" } },
            { node: { __typename: "GraphImage", display_url: "https://scontent.cdninstagram.com/v/t51.1/3.jpg" } },
          ],
        },
      },
    },
  });
  const { imageUrls } = extractInstagramImageHintsFromJsonText(raw, "CAR12345");
  assert.deepEqual(imageUrls, [
    "https://scontent.cdninstagram.com/v/t51.1/1.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/3.jpg",
  ]);
});

test("dedupeInstagramPhotos: merges CDN origins by pathname, prefers full-size", () => {
  const urls = [
    "https://scontent.cdninstagram.com/v/t51.1/x.jpg?stp=s640x640",
    "https://scontent.xx.fbcdn.net/v/t51.1/x.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/y.jpg",
  ];
  const out = dedupeInstagramPhotos(urls);
  assert.deepEqual(out, [
    "https://scontent.xx.fbcdn.net/v/t51.1/x.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/y.jpg",
  ]);
});

test("dedupeInstagramPhotos: different pathname crops (s640 vs full) kept separate", () => {
  const urls = [
    "https://scontent.cdninstagram.com/v/t51.1/x_s640x640.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/x.jpg",
    "https://scontent.xx.fbcdn.net/v/t51.1/y.jpg",
  ];
  const out = dedupeInstagramPhotos(urls);
  assert.deepEqual(out, [
    "https://scontent.cdninstagram.com/v/t51.1/x_s640x640.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/x.jpg",
    "https://scontent.xx.fbcdn.net/v/t51.1/y.jpg",
  ]);
});

test("dedupeInstagramPhotos: drops avatar urls", () => {
  const urls = [
    "https://scontent.cdninstagram.com/v/t51.1/real.jpg",
    efgUrl({ vencode_tag: "profile_pic_560" }, "https://scontent.cdninstagram.com/v/t51.1/avatar.jpg"),
  ];
  const out = dedupeInstagramPhotos(urls);
  assert.deepEqual(out, ["https://scontent.cdninstagram.com/v/t51.1/real.jpg"]);
});

test("filterInstagramCandidatesForTarget: exact URL hint wins over asset-id", () => {
  const exact = "https://x.com/exact.mp4";
  const byAsset = efgUrl({ xpv_asset_id: "same" }, "https://x.com/byasset.mp4");
  const other = "https://x.com/other.mp4";
  const out = filterInstagramCandidatesForTarget(
    [byAsset, other, exact],
    new Set([exact]),
    new Set(["same"])
  );
  assert.deepEqual(out, [exact]);
});

test("filterInstagramCandidatesForTarget: falls back to asset-id match", () => {
  const byAsset = efgUrl({ xpv_asset_id: "same" }, "https://x.com/byasset.mp4");
  const other = "https://x.com/other.mp4";
  const out = filterInstagramCandidatesForTarget([other, byAsset], new Set(), new Set(["same"]));
  assert.deepEqual(out, [byAsset]);
});

test("filterInstagramCandidatesForTarget: no hints → passthrough", () => {
  const urls = ["https://x.com/a.mp4", "https://x.com/b.mp4"];
  assert.deepEqual(filterInstagramCandidatesForTarget(urls), urls);
});

test("filterInstagramCandidatesForTarget: byte-range variant still URL-matches", () => {
  const a = "https://x.com/a.mp4";
  const out = filterInstagramCandidatesForTarget([a], new Set([a + "?bytestart=0&byteend=9"]));
  assert.deepEqual(out, [a]);
});