// ReAnime provider — uses /pop to fetch already-resolved FlixCloud.cc embed URLs.
//
// The entire reanime.to scraper (search/resolveSeries/fetchServers) was REMOVED
// because the new /pop endpoint already does that resolution server-side.
// /pop's `re` provider entry returns direct flixcloud.cc URLs we just hand to
// the iframe.
//
// URL STRATEGY (per user spec):
//   1. PRIMARY — Read the URL directly from the /pop endpoint's `re` entry.
//      /pop returns the FULL flixcloud.cc URL — no need to construct or probe.
//   2. NOT AVAILABLE — If /pop doesn't have the entry OR the URL for the
//      requested audio type, return empty streams (UI shows "Stream
//      Unavailable"). NO env-constructed fallback — ReAnime's URLs are
//      fundamentally different (a separate flixcloud.cc domain, not our
//      embed API), so we can't synthesize one.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[] with provider="re" → urls.{sub,dub}
//          sub = https://flixcloud.cc/e/<id>?v=1
//          dub = https://flixcloud.cc/e/<id>?a=1

import { json } from "../core/new-provider-utils.js";
import { getPopEntry } from "../core/pop-fetcher.js";

const POP_PROVIDER_ID = "re";

async function handleWatch(anilistId, audio, epNum) {
  // Read URL directly from /pop — no env-constructed fallback for ReAnime
  // (its URLs are on a different host we can't synthesize).
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
  const url   = entry?.urls?.[audio] ?? null;

  if (!url) {
    // /pop didn't return a stream for this server+audio → "not available"
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

// Real per-episode sub/dub availability — reads /pop's `re` entry.
// Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (ReAnime never has hsub via the API.)
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
