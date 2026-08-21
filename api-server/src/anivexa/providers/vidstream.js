// VidStream provider — uses /pop's `default` entry (plain Megaplay, no ?p= param).
// The site tab is still labelled "VidStream" — swapped with Core so Core
// got the "rich-looking" ?p=vs player.
//
// URL STRATEGY (per user spec):
//   Read the URL directly from /pop's `default` entry. NO FALLBACK.
//   If /pop doesn't return a stream (entry missing or URL field absent),
//   return empty streams → UI shows "Stream Unavailable".
//
//   The /co fallback is for Core ONLY — VidStream never uses it.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[] with provider="default" carrying urls.{sub,dub}

import { json } from "../core/new-provider-utils.js";
import { getPopEntry } from "../core/pop-fetcher.js";

const POP_PROVIDER_ID = "default";

async function handleWatch(anilistId, audio, epNum) {
  // VidStream only carries sub + dub — coerce hsub → sub.
  const type = audio === "dub" ? "dub" : "sub";

  // Read URL directly from /pop — NO fallback for VidStream.
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
    streams: [{
      url,
      type:     "embed",
      server:   `VidStream-${type}`,
      isActive: true,
    }],
  });
}

// Real per-episode sub/dub availability — reads /pop's `default` entry.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (VidStream never has hsub.)
export async function getAudioOptions(anilistId, epNum) {
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
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
