// AniNico provider — uses /pop's `am` entry (Megaplay AniNico player, ?p=am).
// This is the ONLY server that supports hsub (hard-subtitled Japanese audio).
//
// URL STRATEGY (per user spec):
//   Read the URL directly from /pop's `am` entry. NO FALLBACK.
//   If /pop doesn't return a stream (entry missing or URL field absent),
//   return empty streams → UI shows "Stream Unavailable".
//
//   The /co fallback is for Core ONLY — AniNico never uses it.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[] with provider="am" carrying urls.{sub,dub,hsub?}

import { json } from "../core/new-provider-utils.js";
import { getPopEntry } from "../core/pop-fetcher.js";

const POP_PROVIDER_ID = "am";

function resolveType(audio) {
  if (audio === "dub")  return "dub";
  if (audio === "hsub") return "hsub";
  return "sub";
}

async function handleWatch(anilistId, audio, epNum) {
  const type = resolveType(audio);

  // Read URL directly from /pop — NO fallback for AniNico.
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
  const url   = entry?.urls?.[type] ?? null;

  // /pop didn't return a stream → "Stream Unavailable"
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
