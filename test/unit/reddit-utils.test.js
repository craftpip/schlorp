const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRedditUrl,
  isRedditSavedUrl,
  normalizeRedditPostUrl,
  extractRedditPostId,
  isRedditVideoPost,
  extractRedditMediaHintsFromJsonText,
  extractRedditImageHintsFromJsonText,
  dedupeRedditPhotos,
} = require("../../scan-videos/reddit-utils");

function listingJson(posts, extra = {}) {
  return JSON.stringify([
    {
      kind: "Listing",
      data: { children: posts.map((data) => ({ kind: "t3", data })) },
      ...extra,
    },
  ]);
}

test("isRedditUrl: reddit hostnames true, others false", () => {
  assert.equal(isRedditUrl("https://www.reddit.com/r/x/"), true);
  assert.equal(isRedditUrl("https://reddit.com/"), true);
  assert.equal(isRedditUrl("https://old.reddit.com/r/x/comments/abc/"), true);
  assert.equal(isRedditUrl("https://notreddit.com/"), false);
  assert.equal(isRedditUrl("https://reddit.com.example.com/"), false);
  assert.equal(isRedditUrl("not a url"), false);
});

test("isRedditSavedUrl: saved listing true, other reddit pages false", () => {
  assert.equal(isRedditSavedUrl("https://www.reddit.com/user/me/saved/"), true);
  assert.equal(isRedditSavedUrl("https://old.reddit.com/user/me/saved"), true);
  assert.equal(isRedditSavedUrl("https://www.reddit.com/r/x/comments/abc/"), false);
  assert.equal(isRedditSavedUrl("https://www.reddit.com/user/me/"), false);
  assert.equal(isRedditSavedUrl("https://example.com/"), false);
});

test("normalizeRedditPostUrl: strips query/hash and trailing slashes", () => {
  assert.equal(
    normalizeRedditPostUrl("https://www.reddit.com/r/X/comments/abc/title/?utm_source=share&utm_medium=web2x"),
    "https://www.reddit.com/r/X/comments/abc/title"
  );
  assert.equal(
    normalizeRedditPostUrl("https://www.reddit.com/r/X/comments/abc/title#comment"),
    "https://www.reddit.com/r/X/comments/abc/title"
  );
});

test("normalizeRedditPostUrl: keeps old.reddit.com host and original scheme", () => {
  assert.equal(
    normalizeRedditPostUrl("https://old.reddit.com/r/X/comments/abc/"),
    "https://old.reddit.com/r/X/comments/abc"
  );
  assert.equal(
    normalizeRedditPostUrl("http://www.reddit.com/r/X/comments/abc/"),
    "http://www.reddit.com/r/X/comments/abc"
  );
});

test("normalizeRedditPostUrl: non-reddit or non-post returns empty", () => {
  assert.equal(normalizeRedditPostUrl("https://example.com/r/X/comments/abc/"), "");
  assert.equal(normalizeRedditPostUrl("https://www.reddit.com/r/X/"), "");
  assert.equal(normalizeRedditPostUrl("not a url"), "");
});

test("extractRedditPostId: extracts id from /comments/ path", () => {
  assert.equal(
    extractRedditPostId("https://www.reddit.com/r/X/comments/1abc23/title/"),
    "1abc23"
  );
  assert.equal(extractRedditPostId("https://old.reddit.com/r/X/comments/1abc23"), "1abc23");
  assert.equal(extractRedditPostId("https://www.reddit.com/r/X/"), "");
  assert.equal(extractRedditPostId("not a url"), "");
});

test("isRedditVideoPost: v.redd.it, gif, hosted:video, redgifs, flags", () => {
  assert.equal(isRedditVideoPost({ domain: "v.redd.it" }), true);
  assert.equal(isRedditVideoPost({ url_overridden_by_dest: "https://v.redd.it/x" }), true);
  assert.equal(isRedditVideoPost({ is_video: true }), true);
  assert.equal(isRedditVideoPost({ post_hint: "hosted:video" }), true);
  assert.equal(isRedditVideoPost({ post_hint: "rich:video", domain: "redgifs.com" }), true);
  assert.equal(isRedditVideoPost({ domain: "redgifs.com" }), true);
  assert.equal(isRedditVideoPost({ media: { reddit_video: { fallback_url: "x" } } }), true);
  assert.equal(isRedditVideoPost({ secure_media: { reddit_video: {} } }), true);
  assert.equal(
    isRedditVideoPost({
      url_overridden_by_dest: "https://i.redd.it/abc.gif",
      preview: { images: [{ variants: { mp4: { source: { url: "https://preview.redd.it/abc.mp4?format=mp4" } } } }] },
    }),
    true
  );
  assert.equal(
    isRedditVideoPost({ post_hint: "image", crosspost_parent_list: [{ is_video: true }] }),
    true
  );
  assert.equal(isRedditVideoPost({ post_hint: "image", domain: "i.redd.it" }), false);
  assert.equal(isRedditVideoPost({}), false);
  assert.equal(isRedditVideoPost(null), false);
});

test("extractRedditMediaHintsFromJsonText: v.redd.it post collects all video urls", () => {
  const post = {
    id: "abc123",
    domain: "v.redd.it",
    url_overridden_by_dest: "https://v.redd.it/xyz",
    media: {
      reddit_video: {
        fallback_url: "https://v.redd.it/xyz/DASH_720.mp4",
        hls_url: "https://v.redd.it/xyz/hls.m3u8",
        dash_url: "https://v.redd.it/xyz/DASHPlaylist.mpd",
        scrubber_media_url: "https://v.redd.it/xyz/DASH_240.mp4",
      },
    },
    preview: {
      reddit_video_preview: {
        fallback_url: "https://v.redd.it/xyz/DASH_480.mp4",
        hls_url: "https://v.redd.it/xyz/hls2.m3u8",
      },
    },
  };
  const { urls, redgifsIds, isVideo } = extractRedditMediaHintsFromJsonText(
    listingJson([post]),
    "abc123"
  );
  assert.deepEqual(urls, [
    "https://v.redd.it/xyz",
    "https://v.redd.it/xyz/DASH_720.mp4",
    "https://v.redd.it/xyz/hls.m3u8",
    "https://v.redd.it/xyz/DASHPlaylist.mpd",
    "https://v.redd.it/xyz/DASH_240.mp4",
    "https://v.redd.it/xyz/DASH_480.mp4",
    "https://v.redd.it/xyz/hls2.m3u8",
  ]);
  assert.deepEqual(redgifsIds, []);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: finds post via t3_ name", () => {
  const post = {
    id: "n7x1",
    name: "t3_n7x1",
    domain: "v.redd.it",
    url_overridden_by_dest: "https://v.redd.it/qqq",
  };
  const { urls, isVideo } = extractRedditMediaHintsFromJsonText(listingJson([post]), "n7x1");
  assert.deepEqual(urls, ["https://v.redd.it/qqq"]);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: gif post yields gif + mp4 preview", () => {
  const post = {
    id: "g1",
    domain: "i.redd.it",
    url_overridden_by_dest: "https://i.redd.it/abc.gif",
    preview: {
      images: [
        {
          variants: { mp4: { source: { url: "https://preview.redd.it/abc.mp4?format=mp4" } } },
          source: { url: "https://preview.redd.it/abc.jpg?width=640" },
        },
      ],
    },
  };
  const { urls, isVideo } = extractRedditMediaHintsFromJsonText(listingJson([post]), "g1");
  assert.deepEqual(urls, ["https://i.redd.it/abc.gif", "https://preview.redd.it/abc.mp4?format=mp4"]);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: redgifs post yields watch/ifr urls + ids", () => {
  const post = {
    id: "r1",
    domain: "redgifs.com",
    url_overridden_by_dest: "https://www.redgifs.com/watch/abcXYZ",
    secure_media: {
      oembed: { html: '<iframe src="https://www.redgifs.com/ifr/abcXYZ"></iframe>' },
    },
  };
  const { urls, redgifsIds, isVideo } = extractRedditMediaHintsFromJsonText(
    listingJson([post]),
    "r1"
  );
  assert.deepEqual(urls, ["https://www.redgifs.com/watch/abcXYZ", "https://www.redgifs.com/ifr/abcXYZ"]);
  assert.deepEqual(redgifsIds, ["abcXYZ"]);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: fallback regex collects embedded redgifs ids", () => {
  const post = { id: "x1", domain: "v.redd.it", url_overridden_by_dest: "https://v.redd.it/zzz" };
  const raw = listingJson([post], {
    meta: { related: "https://www.redgifs.com/watch/aaa111 and https://redgifs.com/ifr/bbb222" },
  });
  const { urls, redgifsIds, isVideo } = extractRedditMediaHintsFromJsonText(raw, "x1");
  assert.deepEqual(urls, ["https://v.redd.it/zzz"]);
  assert.deepEqual(redgifsIds, ["aaa111", "bbb222"]);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: crosspost parent video urls collected", () => {
  const post = {
    id: "c1",
    url_overridden_by_dest: "https://i.redd.it/gray.jpg",
    crosspost_parent_list: [
      { url_overridden_by_dest: "https://v.redd.it/vid", media: { reddit_video: { fallback_url: "https://v.redd.it/vid/DASH_720.mp4" } } },
    ],
  };
  const { urls, isVideo } = extractRedditMediaHintsFromJsonText(listingJson([post]), "c1");
  assert.deepEqual(urls, ["https://v.redd.it/vid", "https://v.redd.it/vid/DASH_720.mp4"]);
  assert.equal(isVideo, true);
});

test("extractRedditMediaHintsFromJsonText: photo-only post is not a video", () => {
  const post = {
    id: "p1",
    domain: "i.redd.it",
    url_overridden_by_dest: "https://i.redd.it/photo.jpg",
  };
  assert.deepEqual(extractRedditMediaHintsFromJsonText(listingJson([post]), "p1"), {
    urls: [],
    redgifsIds: [],
    isVideo: false,
  });
});

test("extractRedditMediaHintsFromJsonText: invalid/empty input returns empty", () => {
  const empty = { urls: [], redgifsIds: [], isVideo: false };
  assert.deepEqual(extractRedditMediaHintsFromJsonText("", "x"), empty);
  assert.deepEqual(extractRedditMediaHintsFromJsonText("not json", "x"), empty);
  assert.deepEqual(extractRedditMediaHintsFromJsonText(listingJson([]), "x"), empty);
});

test("extractRedditImageHintsFromJsonText: single photo via url_overridden_by_dest", () => {
  const post = {
    id: "p1",
    domain: "i.redd.it",
    url_overridden_by_dest: "https://i.redd.it/photo.jpg",
    preview: { images: [{ source: { url: "https://preview.redd.it/photo.jpg?width=1080" } }] },
  };
  const { imageUrls } = extractRedditImageHintsFromJsonText(listingJson([post]), "p1");
  assert.deepEqual(imageUrls, ["https://i.redd.it/photo.jpg"]);
});

test("extractRedditImageHintsFromJsonText: video/gif posts skip poster photo", () => {
  const videoPost = {
    id: "v1",
    domain: "v.redd.it",
    is_video: true,
    url_overridden_by_dest: "https://v.redd.it/poster.jpg",
    preview: { images: [{ source: { url: "https://preview.redd.it/poster.jpg?width=640" } }] },
  };
  assert.deepEqual(extractRedditImageHintsFromJsonText(listingJson([videoPost]), "v1"), {
    imageUrls: [],
  });
  const gifPost = {
    id: "g1",
    domain: "i.redd.it",
    url_overridden_by_dest: "https://i.redd.it/abc.gif",
  };
  assert.deepEqual(extractRedditImageHintsFromJsonText(listingJson([gifPost]), "g1"), {
    imageUrls: [],
  });
});

test("extractRedditImageHintsFromJsonText: gallery order via gallery_data/media_metadata", () => {
  const post = {
    id: "g2",
    gallery_data: { items: [{ media_id: "img1" }, { media_id: "img2" }] },
    media_metadata: {
      img1: { status: "valid", s: { u: "https://i.redd.it/aaa.jpg" } },
      img2: { status: "valid", s: { u: "https://preview.redd.it/bbb.jpg?width=1024" } },
    },
    preview: { images: [{ source: { url: "https://preview.redd.it/dup.jpg?width=640" } }] },
  };
  const { imageUrls } = extractRedditImageHintsFromJsonText(listingJson([post]), "g2");
  assert.deepEqual(imageUrls, ["https://i.redd.it/aaa.jpg", "https://preview.redd.it/bbb.jpg?width=1024"]);
});

test("extractRedditImageHintsFromJsonText: invalid/empty input returns empty", () => {
  assert.deepEqual(extractRedditImageHintsFromJsonText("", "x"), { imageUrls: [] });
  assert.deepEqual(extractRedditImageHintsFromJsonText("not json", "x"), { imageUrls: [] });
});

test("dedupeRedditPhotos: prefers i.redd.it direct over preview", () => {
  const out = dedupeRedditPhotos([
    "https://preview.redd.it/slug-v0-ab12cd34.jpg?width=640",
    "https://i.redd.it/ab12cd34.jpg",
    "https://i.redd.it/other.jpg",
  ]);
  assert.deepEqual(out, ["https://i.redd.it/ab12cd34.jpg", "https://i.redd.it/other.jpg"]);
});

test("dedupeRedditPhotos: keeps distinct basenames, stable order", () => {
  const out = dedupeRedditPhotos([
    "https://i.redd.it/one.jpg",
    "https://i.redd.it/two.jpg",
    "https://i.redd.it/one.jpg",
  ]);
  assert.deepEqual(out, ["https://i.redd.it/one.jpg", "https://i.redd.it/two.jpg"]);
});