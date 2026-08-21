// VidStream provider — embed API using the ?p=vs server.
// Supports sub and dub only (no hsub). Same anix.at source as Core.
//
// Uses the /pop endpoint to get checked sub/dub availability per episode
// instead of probing each URL ourselves — single round-trip per episode.
//
// URL: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/{type}?p=vs
//      type = "sub" | "dub"
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       returns servers[] with provider="vs" carrying urls.{sub,dub}
//
// EMBED_API_URL is read from env (defaults to the animani render instance).

import { json } from "../core/new-provider-utils.js";

const EMBED_API_URL = (process.env.EMBED_API_URL || "https://animani58hggktstisruarusrusrirustis.onrender.com")
  .replace(/\/+$/, "");

const POP_PROVIDER_ID = "vs";

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

function embedUrl(anilistId, epNum, type) {
  return `${EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}?p=vs`;
}

async function handleWatch(anilistId, audio, epNum) {
  const type = audio === "dub" ? "dub" : "sub";
  const url  = embedUrl(anilistId, epNum, type);
  return json({
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    streams: [{
      url,
      type:     "embed",
      server:   `VidStream-${type}`,
      isActive: true,
    }],
  });
}

// Real per-episode sub/dub availability — uses the /pop endpoint's "vs" entry.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (VidStream never has hsub.)
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
      const m = url.pathname.match(/^\/watch\/vidstream\/(\d+)\/(sub|dub)\/vidstream-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
