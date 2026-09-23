const test = require("node:test");
const assert = require("node:assert/strict");

const { hostMatchesSite, siteOfHostname } = require("../../scan-videos/site-hosts");

test("hostMatchesSite: canonical + mirror domains", async () => {
  assert.equal(hostMatchesSite("spankbang.com", "spankbang"), true);
  assert.equal(hostMatchesSite("spankbang.party", "spankbang"), true);
  assert.equal(hostMatchesSite("www.spankbang.party", "spankbang"), true);
  assert.equal(hostMatchesSite("xhamster19.com", "xhamster"), true);
  assert.equal(hostMatchesSite("www.xhamster.com", "xhamster"), true);
  assert.equal(hostMatchesSite("xvideos.es", "xvideos"), true);
  assert.equal(hostMatchesSite("xvideos3.com", "xvideos"), true);
  assert.equal(hostMatchesSite("xnxx2.com", "xvideos"), true);
  assert.equal(hostMatchesSite("redtube.net", "redtube"), true);
  assert.equal(hostMatchesSite("you-porn.com", "youporn"), true);
  assert.equal(hostMatchesSite("pornhub.org", "pornhub"), true);
});

test("hostMatchesSite: rejects lookalikes and other sites", async () => {
  // beeg.porn is a different platform, not beeg.com
  assert.equal(hostMatchesSite("beeg.porn", "beeg"), false);
  assert.equal(hostMatchesSite("beeg.com", "beeg"), true);
  assert.equal(hostMatchesSite("spankbang.com", "xhamster"), false);
  assert.equal(hostMatchesSite("fakespankbang.com", "spankbang"), false);
  assert.equal(hostMatchesSite("", "spankbang"), false);
});

test("siteOfHostname: resolves mirrors to canonical site", async () => {
  assert.equal(siteOfHostname("spankbang.party"), "spankbang");
  assert.equal(siteOfHostname("xhamster19.com"), "xhamster");
  assert.equal(siteOfHostname("www.xvideos.es"), "xvideos");
  assert.equal(siteOfHostname("example.com"), "");
});

test("hostMatchesSite: JAV tubes", async () => {
  assert.equal(hostMatchesSite("missav.ws", "jav"), true);
  assert.equal(hostMatchesSite("supjav.com", "jav"), true);
  assert.equal(hostMatchesSite("jav.guru", "jav"), true);
  assert.equal(hostMatchesSite("www.javmost.ws", "jav"), true);
  assert.equal(hostMatchesSite("javgg.net", "jav"), true);
  assert.equal(hostMatchesSite("javtiful.com", "jav"), true);
  assert.equal(hostMatchesSite("www.bestjavporn.com", "jav"), true);
  assert.equal(hostMatchesSite("sextb.net", "jav"), true);
  assert.equal(hostMatchesSite("vjav.com", "jav"), true);
  assert.equal(hostMatchesSite("missav.ws", "xhamster"), false);
});
