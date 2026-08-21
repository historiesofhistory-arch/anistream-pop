// AniNico provider — uses the embed API with the AniNeco (?p=am) server.
// This is the ONLY server that supports hsub (hard-subtitled Japanese audio).
//
// Uses the /pop endpoint to get checked sub/dub/hsub availability per episode
// instead of probing each URL ourselves — single round-trip per episode.
//
// Endpoint: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/{type}?p=am
//           type = "sub" | "dub" | "hsub"
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       returns servers[] with provider="am" carrying urls.{sub,dub,hsub}
//
// EMBED_API_URL is read from env (defaults to the animani render instance).
// Set it in your environment to point at your own hosted instance.

import { json } from "../core/new-provider-utils.js";

const EMBED_API_URL = (process.env.EMBED_API_URL || "https://animani58hggktstisruarusrusrirustis.onrender.com")
  .replace(/\/+$/, "");

const POP_PROVIDER_ID = "am";

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
  return `${EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}?p=am`;
}

function resolveType(audio) {
  if (audio === "dub")  return "dub";
  if (audio === "hsub") return "hsub";
  return "sub";
}

async function handleWatch(anilistId, audio, epNum) {
  const type = resolveType(audio);
  const url  = embedUrl(anilistId, epNum, type);
  return json({
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    isHardSub: type === "hsub",
    streams: [
      {
        url,
        type:     "embed",
        server:   `AniNico-${type}`,
        isActive: true,
      },
    ],
  });
}

// Real per-episode sub/dub/hsub availability — uses the /pop endpoint's "am" entry.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
//   hsub → "Japanese (H-Sub)"  ← only AniNico ever returns this
export async function getAudioOptions(anilistId, epNum) {
  const entry = await getMyPopEntry(anilistId, epNum);
  if (!entry?.urls) return [];
  const out = [];
  if (entry.urls.sub)  out.push({ code: "sub",  label: "Japanese" });
  if (entry.urls.dub)  out.push({ code: "dub",  label: "English" });
  if (entry.urls.hsub) out.push({ code: "hsub", label: "Japanese (H-Sub)" });
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
      const m = url.pathname.match(/^\/watch\/aninico\/(\d+)\/(sub|dub|hsub)\/aninico-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
