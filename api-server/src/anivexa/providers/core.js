// Core provider — uses the VidStream (?p=vs) Megaplay player for its UI
// (user preference: "looks rich"). The site tab is labelled "Core" but the
// underlying stream comes from /pop's `vs` entry.
//
// FALLBACK STRATEGY (Core ONLY — per user spec):
//   When /pop is not working (unreachable, 5xx, or returns no URL), Core
//   falls back to the /co endpoint — the original Core embed pattern:
//     {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/{type}/co
//
//   The /co endpoint:
//     - Supports sub + dub only (NO hsub — confirmed via direct test, returns HTTP 502 for hsub)
//     - hsub audio is coerced to sub before the fallback fires
//     - URL is env-configurable via EMBED_API_URL
//
//   No other provider has a fallback. VidStream, AniNico, and ReAnime all
//   return empty streams (UI shows "Stream Unavailable") when /pop doesn't
//   return a URL — only Core gets the /co safety net.
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[] with provider="vs" carrying urls.{sub,dub}

import { json } from "../core/new-provider-utils.js";
import { getPopEntry, POP_EMBED_API_URL } from "../core/pop-fetcher.js";

// Core reads /pop's `vs` entry — that's where the "rich-looking" VidStream
// player URLs live.
const POP_PROVIDER_ID = "vs";

// FALLBACK: only for Core — uses the /co endpoint (original Core embed pattern).
// /co doesn't support hsub (caller coerces hsub → sub before calling this).
// Reads POP_EMBED_API_URL from env so changing EMBED_API_URL changes both
// /pop and this fallback in lockstep.
function coFallbackUrl(anilistId, epNum, type) {
  return `${POP_EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}/co`;
}

async function handleWatch(anilistId, audio, epNum) {
  // /co doesn't support hsub — coerce to sub. (Pop's `vs` entry only has
  // sub+dub too, so this coercion applies to BOTH the pop URL and the fallback.)
  const type = audio === "dub" ? "dub" : "sub";

  // PRIMARY: read URL directly from /pop's `vs` entry
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
  const popUrl = entry?.urls?.[type] ?? null;

  // FALLBACK (Core-only): when /pop is not working or returns no URL,
  // fall back to the /co endpoint. This is the ONLY fallback in the system.
  const url = popUrl ?? coFallbackUrl(anilistId, epNum, type);

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

// Real per-episode audio availability — reads /pop's `vs` entry.
// /pop has its own built-in checker, so the urls{} keys are exactly what's
// available. Hardcoded labels per the spec:
//   sub  → "Japanese"
//   dub  → "English"
// (Core never has hsub — only AniNico does.)
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
      const m = url.pathname.match(/^\/watch\/core\/(\d+)\/(sub|dub|hsub)\/core-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
