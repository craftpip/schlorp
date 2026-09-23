// Canonical + mirror hostnames per supported site (plan 036).
// Only hosts verified to serve the SAME platform/player are listed:
// - xhamster19.com: same /videos/<slug>-xhXXX structure as xhamster.com
// - xvideos.es / xvideos3.com: same /video.<id>/ structure as xvideos.com
// - xnxx2.com: same structure as xnxx.com
// - redtube.net: redirects from redtube.com, same pages
// - you-porn.com: redirect target of youporn.com, same pages
// - spankbang.party: same /<id>/video/<slug> structure as spankbang.com
// - pornhub.org: redirect target of pornhub.com, same pages
// NOTE: beeg.porn is a DIFFERENT platform (/play/ aggregator), NOT beeg.com
// (externulls API) — deliberately excluded.

const SITE_HOSTS = {
  xhamster: ["xhamster.com", "xhamster19.com"],
  xvideos: ["xvideos.com", "xvideos.es", "xvideos3.com", "xnxx.com", "xnxx2.com"],
  pornhub: ["pornhub.com", "pornhub.org"],
  spankbang: ["spankbang.com", "spankbang.party"],
  eporner: ["eporner.com"],
  beeg: ["beeg.com"],
  kvs: ["porntrex.com", "txxx.com"],
  hqporner: ["hqporner.com"],
  youjizz: ["youjizz.com"],
  redtube: ["redtube.com", "redtube.net"],
  youporn: ["youporn.com", "you-porn.com"],
  // JAV tubes (plan 036 §9). Reachability 2026-09-23 via cloakbrowser:
  // missav.ws/supjav.com/jav.guru/javmost.ws/javgg.net/javtiful.com/
  // bestjavporn.com/sextb.net live; vjav.com hung (bot-wall), javfinder.sh
  // DNS-dead, javseen.com refused — kept in list, verify from container.
  jav: [
    "missav.ws", "missav.com", "missav.ai",
    "supjav.com",
    "jav.guru",
    "javmost.com", "javmost.ws",
    "vjav.com",
    "javgg.net",
    "javfinder.sh",
    "javtiful.com", "jav.si",
    "bestjavporn.com",
    "javseen.com", "javseen.tv",
    "sextb.net",
  ],
  reddit: ["reddit.com"],
  instagram: ["instagram.com"],
};

function hostMatchesSite(hostname, site) {
  const hosts = SITE_HOSTS[site] || [];
  const lower = String(hostname || "").toLowerCase();
  return hosts.some(
    (h) => lower === h || lower.endsWith(`.${h}`)
  );
}

function siteOfHostname(hostname) {
  const lower = String(hostname || "").toLowerCase();
  if (!lower) return "";
  for (const site of Object.keys(SITE_HOSTS)) {
    if (hostMatchesSite(lower, site)) return site;
  }
  return "";
}

module.exports = { SITE_HOSTS, hostMatchesSite, siteOfHostname };
