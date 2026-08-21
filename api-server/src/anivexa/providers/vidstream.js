// VidStream provider — uses the plain default Megaplay embed (no ?p= param).
// The site tab is still labelled "VidStream" but the underlying API endpoint
// is now the default Megaplay player. (Swap with Core — Core took the ?p=vs
// player because it "looks rich".)
//
// URL STRATEGY (per user spec):
//   1. PRIMARY — Read the URL directly from the /pop endpoint's `default`
//      entry. /pop returns the FULL URL (env-baked host, no ?p= query) — no
//      need to construct or probe anything.
//   2. FALLBACK — Construct URL using EMBED_API_URL if /pop is missing it.
//   3. NOT AVAILABLE — UI shows "Stream Unavailable" if neither path works.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[].urls.{sub,dub}  (no hsub on VidStream)

import { json } from "../core/new-provider-utils.js";
import { getPopEntry, POP_EMBED_API_URL } from "../core/pop-fetcher.js";

// VidStream uses the plain default endpoint (no ?p=vs).
const POP_PROVIDER_ID = "default";

// Fallback URL constructor — only used when /pop doesn't have the URL.
function embedUrl(anilistId, epNum, type) {
  return `${POP_EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}`;
}

async function handleWatch(anilistId, audio, epNum) {
  // VidStream only carries sub + dub — coerce hsub → sub.
  const type = audio === "dub" ? "dub" : "sub";

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
