// Core provider — uses the VidStream (?p=vs) Megaplay player for its UI
// (user preference: "looks rich"). The site tab is labelled "Core" but the
// underlying API endpoint is `?p=vs`.
//
// URL STRATEGY (per user spec):
//   1. PRIMARY — Read the URL directly from the /pop endpoint's `vs` entry.
//      /pop returns the FULL URL (env-baked host + ?p=vs query) — no need
//      to construct or probe anything. The /pop endpoint's built-in audio
//      checker already knows whether sub/dub exist for this episode.
//   2. FALLBACK — If /pop doesn't have the URL (entry missing or field
//      absent), construct the URL using EMBED_API_URL (user-given pattern).
//      Both the /pop call and the fallback use the same env, so changing
//      EMBED_API_URL changes both.
//   3. NOT AVAILABLE — If even the fallback doesn't apply (it always does
//      for Core), the UI shows "Stream Unavailable".
//
// /pop: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//       → servers[].urls.{sub,dub}  (no hsub on Core — only AniNico has it)

import { json } from "../core/new-provider-utils.js";
import { getPopEntry, POP_EMBED_API_URL } from "../core/pop-fetcher.js";

// Core uses the VidStream player (?p=vs).
const POP_PROVIDER_ID = "vs";

// Fallback URL constructor — only used when /pop doesn't have the URL.
function embedUrl(anilistId, epNum, type) {
  return `${POP_EMBED_API_URL}/api/stream/anix.at/${anilistId}/${epNum}/${type}?p=vs`;
}

async function handleWatch(anilistId, audio, epNum) {
  // Core only carries sub + dub — coerce hsub → sub so the route stays valid
  // even if a stale URL with ?lang=hsub is hit.
  const type = audio === "dub" ? "dub" : "sub";

  // ── PRIMARY: read the URL directly from /pop ────────────────────────────────
  // /pop already returns the complete URL with the env-baked host and the
  // correct ?p=vs query — no need to construct anything.
  const entry = await getPopEntry(anilistId, epNum, POP_PROVIDER_ID);
  let url = entry?.urls?.[type] ?? null;

  // ── FALLBACK: construct URL with env (user-given pattern) ──────────────────
  // Used when /pop is down, missing the entry, or missing the field.
  // The env-baked URL keeps both paths in sync with the same EMBED_API_URL.
  if (!url) {
    url = embedUrl(anilistId, epNum, type);
  }

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

// Real per-episode audio availability — reads /pop's `vs` entry directly.
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
