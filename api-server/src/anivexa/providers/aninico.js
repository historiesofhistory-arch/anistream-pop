// AniNico provider — uses the embed API with the AniNico (?p=am) server.
// This is the ONLY server that supports hsub (hard-subtitled Japanese audio).
//
// URL STRATEGY (per user spec):
//   1. PRIMARY — Read the URL directly from the /pop endpoint's `am` entry.
//      /pop returns the FULL URL (env-baked host + ?p=am query + the audio
//      type already in the path) — no need to construct or probe anything.
//   2. FALLBACK — Construct URL using EMBED_API_URL if /pop is missing it.
//   3. NOT AVAILABLE — UI shows "Stream Unavailable" if neither path works.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[].urls.{sub,dub,hsub}
//          Only AniNico ever carries hsub — /pop knows this.

import { json } from "../core/new-provider-utils.js";
import { getPopEntry, POP_EMBED_API_URL } from "../core/pop-fetcher.js";

const POP_PROVIDER_ID = "am";

// Fallback URL constructor — only used when /pop doesn't have the URL.
function embedUrl(anilistId, epNum, type) {
  return `${POP_EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}?p=am`;
}

function resolveType(audio) {
  if (audio === "dub")  return "dub";
  if (audio === "hsub") return "hsub";
  return "sub";
}

async function handleWatch(anilistId, audio, epNum) {
  const type = resolveType(audio);

  // PRIMARY: read URL directly from /pop
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
  let url = entry?.urls?.[type] ?? null;

  // FALLBACK: env-constructed URL (user-given pattern)
  if (!url) {
    url = embedUrl(anilistId, epNum, type);
  }

  return json({
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    isHardSub: type === "hsub",
    streams: [{
      url,
      type:     "embed",
      server:   `AniNico-${type}`,
      isActive: true,
    }],
  });
}

// Real per-episode sub/dub/hsub availability — reads /pop's `am` entry.
// /pop's built-in checker already knows whether hsub exists for this episode.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
//   hsub → "Japanese (H-Sub)"  ← only AniNico ever returns this
export async function getAudioOptions(anilistId, epNum) {
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
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
