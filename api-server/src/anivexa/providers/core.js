// Core provider — default Megaplay embed (anix.at source via the new stream API).
// Supports sub and dub. NO hsub on this server (only AniNico carries hsub).
//
// The new stream API exposes a fast "/pop" endpoint that pre-checks which
// audio tracks each provider actually has for an episode. We use it instead
// of probing each URL ourselves — single round-trip per episode (cached 10 min).
//
// URL: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/{type}
//      (type = "sub" | "dub")
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       returns servers[] with provider="default" carrying urls.{sub,dub}
//
// The embed API origin is read from EMBED_API_URL (defaults to the public
// animani render instance). Set EMBED_API_URL in your environment to point at
// your own hosted instance.

import { json } from "../core/new-provider-utils.js";

const EMBED_API_URL = (process.env.EMBED_API_URL || "https://animani58hggktstisruarusrusrirustis.onrender.com")
  .replace(/\/+$/, "");

// This provider's id within the /pop servers[] array. Core = "default".
const POP_PROVIDER_ID = "default";

// ── /pop cache ───────────────────────────────────────────────────────────────
// One round-trip per (anilistId, epNum) instead of three probes per server.
const POP_CACHE = new Map(); // key → { data, expires }
const POP_TTL   = 10 * 60 * 1000; // 10 minutes for successful probes
const POP_ERR   = 60 * 1000;       // 1 minute for failed probes

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

// Pull the Core provider entry out of /pop's servers[] array.
async function getMyPopEntry(anilistId, epNum) {
  const pop = await fetchPop(anilistId, epNum);
  if (!pop?.servers) return null;
  return pop.servers.find((s) => s.provider === POP_PROVIDER_ID) ?? null;
}

function embedUrl(anilistId, epNum, type) {
  return `${EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}`;
}

async function handleWatch(anilistId, audio, epNum) {
  // Core only carries sub + dub — coerce hsub → sub so the route stays valid.
  const type = audio === "dub" ? "dub" : "sub";
  const url  = embedUrl(anilistId, epNum, type);
  return json({
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    isHardSub: false,
    streams: [{
      url,
      type:     "embed",
      server:   `Core-${type}`,
      isActive: true,
    }],
  });
}

// Real per-episode availability — uses the /pop endpoint's "default" entry.
// Returns only the audio codes the API actually has for this episode+server.
//
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (Core never has hsub — only AniNico does — so we never return hsub here.)
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
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    try {
      const m = url.pathname.match(/^\/watch\/core\/(\d+)\/(sub|dub|hsub)\/core-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
