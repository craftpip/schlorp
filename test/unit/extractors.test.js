const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakePage } = require("../helpers/make-fake-page");
const {
  extractXhamsterMediaData,
  extractXvideosMediaUrls,
  extractPornhubMediaData,
  expandPornhubGetMediaUrls,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
  extractInstagramPhotoData,
  extractRedditMediaData,
  fetchRedgifsMediaUrls,
} = require("../../scan-videos/extractors");

function fakeDocument(options = {}) {
  const { title = "", query = {}, all = {} } = options;
  return {
    title,
    querySelector: (sel) => (sel in query ? query[sel] : null),
    querySelectorAll: (sel) => (sel in all ? all[sel] : []),
  };
}

function hotlink(href) {
  return { getAttribute: (name) => (name === "href" ? href : null) };
}

function srcElement(attrs = {}) {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    ...attrs,
    getBoundingClientRect: () => ({ width: 500, height: 500 }),
  };
}

test("extractXhamsterMediaData: walks window.initials, resolves relative URLs, dedupes", async () => {
  const page = makeFakePage({
    url: "https://www.xhamster.com/videos/123",
    window: {
      initials: {
        sources: [
          { url: "/v/720.mp4", height: 720, width: 1280 },
          { url: "https://cdn.xh.com/v/1080.mp4", height: 1080, width: 1920, bitrate: 4000000 },
        ],
        video: { file: "https://cdn.xh.com/m.m3u8" },
      },
    },
    document: fakeDocument({
      query: {},
      all: {
        'link[rel="preload"][as="fetch"][href]': [hotlink("https://cdn.xh.com/preload.mp4")],
        script: [],
      },
    }),
  });

  const { urls, qualityByUrl } = await extractXhamsterMediaData(page);
  assert.deepEqual(urls, [
    "https://www.xhamster.com/v/720.mp4",
    "https://cdn.xh.com/v/1080.mp4",
    "https://cdn.xh.com/m.m3u8",
    "https://cdn.xh.com/preload.mp4",
  ]);
  assert.ok(qualityByUrl instanceof Map);
  assert.ok(qualityByUrl.get("https://cdn.xh.com/v/1080.mp4") > qualityByUrl.get("https://www.xhamster.com/v/720.mp4"));
});

test("extractXhamsterMediaData: script regex collects escaped URLs, dedupes same URL", async () => {
  const page = makeFakePage({
    url: "https://www.xhamster.com/videos/123",
    window: { initials: { video: { url: "https://cdn.xh.com/dup.mp4" } } },
    document: fakeDocument({
      query: {},
      all: {
        'link[rel="preload"][as="fetch"][href]': [],
        script: [
          {
            textContent:
              '{"sources":[{"url":"https:\\/\\/cdn.xh.com\\/dup.mp4","height":720},{"url":"https:\\/\\/cdn.xh.com\\/720.mp4"}]}',
          },
        ],
      },
    }),
  });

  const { urls } = await extractXhamsterMediaData(page);
  assert.deepEqual(urls, ["https://cdn.xh.com/dup.mp4", "https://cdn.xh.com/720.mp4"]);
});

test("extractXvideosMediaUrls: html5player fields + script patterns, relative resolved", async () => {
  const page = makeFakePage({
    url: "https://www.xvideos.com/video123/xyz",
    window: {
      html5player: {
        url_high: "https://cdn.x.com/high.mp4",
        url_low: "https://cdn.x.com/low.mp4",
        hls: "https://cdn.x.com/h.m3u8",
      },
    },
    document: fakeDocument({
      query: {},
      all: {
        script: [
          {
            textContent:
              "setVideoHLS('https://cdn.x.com/sh.m3u8'); \"videoDash\":\"https://cdn.x.com/dash.mpd\"; setVideoUrlHigh('/rel.mp4')",
          },
        ],
      },
    }),
  });

  const urls = await extractXvideosMediaUrls(page);
  assert.deepEqual(urls, [
    "https://cdn.x.com/high.mp4",
    "https://cdn.x.com/low.mp4",
    "https://cdn.x.com/h.m3u8",
    "https://www.xvideos.com/rel.mp4",
    "https://cdn.x.com/sh.m3u8",
    "https://cdn.x.com/dash.mpd",
  ]);
});

test("extractXvideosMediaUrls: no player, no scripts returns empty", async () => {
  const page = makeFakePage({ url: "https://www.xvideos.com/v/1", document: fakeDocument() });
  assert.deepEqual(await extractXvideosMediaUrls(page), []);
});

test("extractPornhubMediaData: flashvars scan + get_media + quality scoring", async () => {
  const page = makeFakePage({
    url: "https://www.pornhub.com/view_video.php?viewkey=1",
    window: {
      flashvars_mediaDefinitions: [
        { videoUrl: "https://cdn.ph.com/a.mp4", quality: "1080p", height: 720, width: 1280 },
        { url: "https://cdn.ph.com/hls1.m3u8" },
      ],
      MDL_FLASHVARS: { video: { url: "https://cdn.ph.com/video/get_media/xxx" } },
    },
    document: fakeDocument({
      query: {},
      all: { script: [] },
    }),
  });

  const { urls, qualityByUrl } = await extractPornhubMediaData(page);
  assert.deepEqual(urls, [
    "https://cdn.ph.com/a.mp4",
    "https://cdn.ph.com/hls1.m3u8",
    "https://cdn.ph.com/video/get_media/xxx",
  ]);
  assert.ok(qualityByUrl.get("https://cdn.ph.com/a.mp4") > 0);
  assert.equal(qualityByUrl.get("https://cdn.ph.com/hls1.m3u8"), undefined);
});

test("expandPornhubGetMediaUrls: fetches up to 3 get_media urls, collects videoUrl entries", async () => {
  const served = [];
  const page = makeFakePage({
    url: "https://www.pornhub.com/view_video.php?viewkey=1",
    document: fakeDocument(),
    fetchHandler: async (u) => {
      served.push(u);
      return {
        ok: true,
        json: async () => ({
          mediaDefinitions: [
            { videoUrl: `${u}/resolved.mp4`, height: 720, width: 1280 },
            { videoUrl: `${u}/resolved.m3u8`, height: 0 },
          ],
        }),
      };
    },
  });

  const plain = "https://cdn.ph.com/plain.mp4";
  const gm1 = "https://cdn.ph.com/video/get_media/1";
  const gm2 = "https://cdn.ph.com/video/get_media/2";
  const gm3 = "https://cdn.ph.com/video/get_media/3";
  const gm4 = "https://cdn.ph.com/video/get_media/4";
  const { urls, qualityByUrl } = await expandPornhubGetMediaUrls(page, [plain, gm1, gm2, gm3, gm4]);
  assert.deepEqual(served, [gm1, gm2, gm3]);
  assert.deepEqual(urls, [
    `${gm1}/resolved.mp4`,
    `${gm1}/resolved.m3u8`,
    `${gm2}/resolved.mp4`,
    `${gm2}/resolved.m3u8`,
    `${gm3}/resolved.mp4`,
    `${gm3}/resolved.m3u8`,
  ]);
  assert.ok(qualityByUrl instanceof Map);
  assert.ok(qualityByUrl.get(`${gm1}/resolved.mp4`) > 0);
});

test("expandPornhubGetMediaUrls: no get_media urls → empty result, no fetch", async () => {
  let called = false;
  const page = makeFakePage({
    url: "https://www.pornhub.com/",
    document: fakeDocument(),
    fetchHandler: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  const result = await expandPornhubGetMediaUrls(page, ["https://cdn.ph.com/plain.mp4"]);
  assert.deepEqual(result.urls, []);
  assert.equal(result.qualityByUrl instanceof Map, true);
  assert.equal(result.qualityByUrl.size, 0);
  assert.equal(called, false);
});

test("getInstagramUsername: extracts from profile path", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/sophiaar.luv/",
    document: fakeDocument(),
  });
  assert.equal(await getInstagramUsername(page), "sophiaar.luv");
});

test("getInstagramUsername: falls back to canonical link on reel pages", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/reel/AbCdE/",
    document: fakeDocument({
      query: {
        'link[rel="canonical"]': hotlink("https://www.instagram.com/sophiaar.luv/"),
      },
      all: {},
    }),
  });
  assert.equal(await getInstagramUsername(page), "sophiaar.luv");
});

test("getInstagramUsername: uses profile anchor when canonical missing", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/reel/AbCdE/",
    document: fakeDocument({
      query: {},
      all: {
        'a[href^="/"]': [hotlink("/other_user")],
      },
    }),
  });
  assert.equal(await getInstagramUsername(page), "other_user");
});

test("getInstagramUsername: reserved route name in profile anchor skipped", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/reel/AbCdE/",
    document: fakeDocument({
      query: {},
      all: {
        'a[href^="/"]': [hotlink("/reel"), hotlink("/sophiaar.luv")],
      },
    }),
  });
  assert.equal(await getInstagramUsername(page), "sophiaar.luv");
});

test("getInstagramUsername: ld+json alternateName/name", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/reel/AbCdE/",
    document: fakeDocument({
      query: {},
      all: {
        'script[type="application/ld+json"]': [
          { textContent: JSON.stringify({ author: [{ alternateName: "sophiaar.luv" }] }) },
        ],
      },
    }),
  });
  assert.equal(await getInstagramUsername(page), "sophiaar.luv");
});

test("getInstagramUsername: page content regex fallback", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/reel/AbCdE/",
    document: fakeDocument(),
    html: '{"xdt_shortcode_media":{"owner":{"username":"sophiaar.luv"}}}',
  });
  assert.equal(await getInstagramUsername(page), "sophiaar.luv");
});

test("getInstagramUsername: nothing found returns empty", async () => {
  const page = makeFakePage({ url: "https://www.instagram.com/reel/AbCdE/", document: fakeDocument() });
  assert.equal(await getInstagramUsername(page), "");
});

test("getInstagramUsernameFromOembed: fetches /api/v1/oembed and reads author_name", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/p/AbCdE/",
    document: fakeDocument(),
    fetchHandler: async (u) => {
      if (u.includes("/api/v1/oembed")) {
        return { ok: true, json: async () => ({ author_name: "sophiaar.luv" }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  assert.equal(await getInstagramUsernameFromOembed(page, "https://www.instagram.com/p/AbCdE/"), "sophiaar.luv");
});

test("getInstagramUsernameFromOembed: reserved author name rejected", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/p/AbCdE/",
    document: fakeDocument(),
    fetchHandler: async () => ({ ok: true, json: async () => ({ author: "reel" }) }),
  });
  assert.equal(await getInstagramUsernameFromOembed(page, "https://www.instagram.com/p/AbCdE/"), "");
});

test("extractInstagramPhotoData: DOM imgs with srcset/w + meta og:image", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/p/Photo123/",
    window: {},
    document: fakeDocument({
      query: {},
      all: {
        "img[src], img[srcset]": [
          srcElement({
            srcset:
              "https://scontent.cdninstagram.com/v/t51.1/p_640.jpg 640w, https://scontent.cdninstagram.com/v/t51.1/p_1080.jpg 1080w",
            naturalWidth: 2048,
          }),
          srcElement({
            src: "https://scontent.cdninstagram.com/v/t51.1/q.jpg",
            naturalWidth: 2048,
          }),
          srcElement({
            src: "https://scontent.cdninstagram.com/v/t51.1/tiny.jpg",
            naturalWidth: 40,
          }),
        ],
      },
    }),
    html: '<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.1/cover.jpg" />',
  });

  const { imageUrls, metaImages } = await extractInstagramPhotoData(page);
  assert.deepEqual(imageUrls, [
    "https://scontent.cdninstagram.com/v/t51.1/p_1080.jpg",
    "https://scontent.cdninstagram.com/v/t51.1/q.jpg",
  ]);
  assert.deepEqual(metaImages, ["https://scontent.cdninstagram.com/v/t51.1/cover.jpg"]);
});

test("extractInstagramPhotoData: filters avatar urls from meta", async () => {
  const page = makeFakePage({
    url: "https://www.instagram.com/p/Photo123/",
    document: fakeDocument(),
    html: '<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.1/avatar.jpg?efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljIn0" /><meta name="twitter:image" content="https://scontent.cdninstagram.com/v/t51.1/cover.jpg" />',
  });

  const { imageUrls, metaImages } = await extractInstagramPhotoData(page);
  assert.deepEqual(imageUrls, []);
  assert.deepEqual(metaImages, ["https://scontent.cdninstagram.com/v/t51.1/cover.jpg"]);
});

test("extractRedditMediaData: shreddit-post, video, links, imgs, scripts, deep scan", async () => {
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/",
    window: {
      __PRELOADED_STATE__: { posts: { media: "https://v.redd.it/zzz" } },
    },
    document: fakeDocument({
      query: {},
      all: {
        "shreddit-post[content-href]": [
          { getAttribute: (n) => (n === "content-href" ? "https://v.redd.it/abc" : null) },
        ],
        "video, video source, source[src]": [{ src: "https://v.redd.it/DASH.mp4" }],
        'a[href*="redgifs"], a[href*="redd.it"], a[href*="v.redd"] ': [
          hotlink("https://www.redgifs.com/watch/aaa111"),
        ],
        'img[src*="preview.redd.it"]': [
          { getAttribute: () => "https://preview.redd.it/x.mp4?format=mp4" },
        ],
        "img[src]": [{ getAttribute: () => "https://i.redd.it/photo.jpg" }],
        script: [{ textContent: "// https://cdn.rd.com/master.m3u8" }],
      },
    }),
  });

  const { urls, redgifsIds, imageUrls } = await extractRedditMediaData(page);
  assert.deepEqual(urls, [
    "https://v.redd.it/abc",
    "https://v.redd.it/DASH.mp4",
    "https://www.redgifs.com/watch/aaa111",
    "https://preview.redd.it/x.mp4?format=mp4",
    "https://cdn.rd.com/master.m3u8",
    "https://v.redd.it/zzz",
  ]);
  assert.deepEqual(redgifsIds, ["aaa111"]);
  assert.deepEqual(imageUrls, ["https://i.redd.it/photo.jpg"]);
});

test("extractRedditMediaData: empty page returns empty lists", async () => {
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/",
    document: fakeDocument(),
  });
  const { urls, redgifsIds, imageUrls } = await extractRedditMediaData(page);
  assert.deepEqual(urls, []);
  assert.deepEqual(redgifsIds, []);
  assert.deepEqual(imageUrls, []);
});

test("extractRedditMediaData: scopes to target post, skips avatars and other posts", async () => {
  const fakeImg = (src, { alt = "", size = 800 } = {}) => ({
    getAttribute: (n) => (n === "src" ? src : n === "alt" ? alt : null),
    src,
    alt,
    closest: () => null,
    getBoundingClientRect: () => ({ width: size, height: size }),
  });
  const fakePost = (permalink, scopedAll) => ({
    getAttribute: (n) => (n === "permalink" ? permalink : null),
    querySelectorAll: (sel) => scopedAll[sel] || [],
  });
  const targetPost = fakePost("/r/x/comments/abc/slug/", {
    "img[src]": [
      fakeImg("https://i.redd.it/avatar.png", { alt: "User avatar", size: 32 }),
      fakeImg("https://i.redd.it/gallery1.jpg"),
    ],
  });
  const otherPost = fakePost("/r/x/comments/zzz/other/", {
    "img[src]": [fakeImg("https://i.redd.it/other.jpg")],
  });
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/slug/",
    document: fakeDocument({
      all: { "shreddit-post[permalink]": [targetPost, otherPost] },
    }),
  });
  const { imageUrls, scoped } = await extractRedditMediaData(page, "abc");
  assert.equal(scoped, true);
  assert.deepEqual(imageUrls, ["https://i.redd.it/gallery1.jpg"]);
});

test("extractRedditMediaData: page-wide fallback drops tiny preview thumbs", async () => {
  const fakeImg = (src) => ({
    getAttribute: (n) => (n === "src" ? src : null),
    src,
    alt: "",
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 500 }),
  });
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/slug/",
    document: fakeDocument({
      all: {
        "img[src]": [
          fakeImg("https://preview.redd.it/ad.png?width=320&height=241&auto=webp&s=aaa"),
          fakeImg("https://preview.redd.it/full.jpg?width=1080&auto=webp&s=bbb"),
        ],
      },
    }),
  });
  // no postId -> unscoped fallback, strict tiny-thumb filter applies
  const { imageUrls, scoped } = await extractRedditMediaData(page);
  assert.equal(scoped, false);
  assert.deepEqual(imageUrls, ["https://preview.redd.it/full.jpg?width=1080&auto=webp&s=bbb"]);
});

test("fetchRedgifsMediaUrls: reads hd/sd from api.redgifs.com response", async () => {
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/",
    document: fakeDocument(),
    fetchHandler: async (u) => {
      if (u.includes("api.redgifs.com")) {
        return {
          ok: true,
          json: async () => ({ gif: { urls: { hd: "https://media.redgifs.com/hd.mp4", sd: "https://media.redgifs.com/sd.mp4" } } }),
        };
      }
      return { ok: false, text: async () => "" };
    },
  });

  const urls = await fetchRedgifsMediaUrls(page, "abcXYZ");
  assert.deepEqual(urls, ["https://media.redgifs.com/hd.mp4", "https://media.redgifs.com/sd.mp4"]);
});

test("fetchRedgifsMediaUrls: falls back to watch page html regex", async () => {
  const page = makeFakePage({
    url: "https://www.reddit.com/r/x/comments/abc/",
    document: fakeDocument(),
    fetchHandler: async (u) => {
      if (u.includes("api.redgifs.com")) {
        return { ok: false, json: async () => null };
      }
      return { ok: true, text: async () => "<div>https://media.redgifs.com/fallback.mp4</div>" };
    },
  });

  const urls = await fetchRedgifsMediaUrls(page, "abcXYZ");
  assert.deepEqual(urls, ["https://media.redgifs.com/fallback.mp4"]);
});

test("fetchRedgifsMediaUrls: empty id returns empty without page access", async () => {
  const page = makeFakePage({ url: "about:blank", document: fakeDocument() });
  assert.deepEqual(await fetchRedgifsMediaUrls(page, ""), []);
});