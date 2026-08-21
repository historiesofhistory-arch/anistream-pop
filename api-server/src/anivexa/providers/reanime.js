// ReAnime provider — uses the new stream API's "/pop" endpoint to fetch
// already-resolved FlixCloud.cc embed URLs (no reanime.to scraping anymore).
//
// Per the user's instruction: "Like the reanime is added in the api only no
// need to use it on the site itself you can use the API" — so the entire
// previous reanime.to scraper (search → resolveSeries → fetchServers →
// serversForAudio) is REPLACED with a single /pop request. The new API already
// knows which AniList ID maps to which FlixCloud embed token, so we just read
// the URLs out of its servers[] entry.
//
// /pop returns provider="re" with urls.{sub,dub} pointing directly at
// flixcloud.cc — no further resolution needed.
//
// URL: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//      → servers[] entry with provider="re"
//      → entry.urls.{sub,dub} are direct flixcloud.cc embed URLs

import { json } from "../core/new-provider-utils.js";

const EMBED_API_URL = (process.env.EMBED_API_URL || "https://animani58hggktstisruarusrusrirustis.onrender.com")
  .replace(/\/+$/, "");

const POP_PROVIDER_ID = "re";

// ── /pop cache (shared via module-level Map) ────────────────────────────────
const POP_CACHE = new Map();
const POP_TTL   = 10 * 60 * 1000;
const POP_ERR   = 60 * 1000;

async function fetchPop(anilistId, epNum) {
  const key   = `${anilistId}:${epNum}`;
  const now   = Date.now();
  const cache = POP_CACHE.get(key);
  if (cache && now < cache.expires) return cache.data;

  const url = `${EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/pop`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      POP_CACHE.set(key, { data: null, expires: now + POP_ERR });
      return null;
    }
    const data = await res.json();
    POP_CACHE.set(key, { data, expires: now + POP_TTL });
    return data;
  } catch {
    POP_CACHE.set(key, { data: null, expires: now + POP_ERR });
    return null;
  }
}

async function getMyPopEntry(anilistId, epNum) {
  const pop = await fetchPop(anilistId, epNum);
  if (!pop?.servers) return null;
  return pop.servers.find((s) => s.provider === POP_PROVIDER_ID) ?? null;
}

async function handleWatch(anilistId, audio, epNum) {
  const entry = await getMyPopEntry(anilistId, epNum);
  const url   = entry?.urls?.[audio] ?? null;
  if (!url) {
    return json({
      anilistId: Number(anilistId),
      episode:   Number(epNum),
      audio,
      streams:   [],
    });
  }
  return json({
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    streams: [{
      url,
      type:     "embed",
      server:   `ReAnime-${audio}`,
      isActive: true,
    }],
  });
}

// Real per-episode sub/dub availability — uses the /pop endpoint's "re" entry.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (ReAnime never has hsub via the API.)
export async function getAudioOptions(anilistId, epNum) {
  const entry = await getMyPopEntry(anilistId, epNum);
  if (!entry?.urls) return [];
  const out = [];
  if (entry.urls.sub) out.push({ code: "sub", label: "Japanese" });
  if (entry.urls.dub) out.push({ code: "dub", label: "English" });
  return out;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/reanime\/(\d+)\/(sub|dub)\/reanime-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
