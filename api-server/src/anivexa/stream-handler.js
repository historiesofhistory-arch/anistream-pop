/**
 * Anivexa streaming bridge.
 *
 * Four providers active now (per the new spec):
 *   - Core (default)    — Megaplay embed, sub + dub
 *   - VidStream (?p=vs) — Megaplay embed via vidstream player, sub + dub
 *   - AniNico (?p=am)    — Megaplay embed via anineko player, sub + dub + hsub
 *   - ReAnime           — direct flixcloud.cc iframe URLs (via /pop endpoint)
 *
 * All four providers use the new /pop endpoint to get pre-checked audio
 * availability per episode (sub/dub/hsub) — no more per-URL probing on our
 * side. Single round-trip per episode, cached 10 minutes.
 *
 * AniDB (the curl-based scraper) and the legacy reanime.to scraper were
 * removed: the new stream API already does that resolution server-side.
 */
// @ts-nocheck
import * as ainicoMod    from "./providers/aninico.js";
import * as coreMod      from "./providers/core.js";
import * as reanimeMod   from "./providers/reanime.js";
import * as vidstreamMod from "./providers/vidstream.js";
import { signProxyUrl }  from "./core/proxy-sign.js";
import { createToken }   from "./core/embed-token-store.js";

/**
 * Wraps any third-party embed URL in our own /api/embed-proxy endpoint so
 * the browser never sees the upstream domain (Koyeb, FlixCloud, etc.).
 *
 * Instead of encoding the URL as a base64url query parameter (decodable by
 * anyone reading the network tab), we store it server-side under a random
 * opaque token.  The token expires after 1 hour and rotates every 5 min,
 * so a token extracted from DevTools has a short shelf-life.
 */
function buildEmbedProxyUrl(rawUrl) {
  const token = createToken(rawUrl);
  return `/api/embed-proxy?t=${token}`;
}

const PROVIDERS = [
  { name: "core",      handler: coreMod.default,       getAudioOptions: coreMod.getAudioOptions      },
  { name: "vidstream", handler: vidstreamMod.default,   getAudioOptions: vidstreamMod.getAudioOptions },
  { name: "aninico",   handler: ainicoMod.default,      getAudioOptions: ainicoMod.getAudioOptions    },
  { name: "reanime",   handler: reanimeMod.default,     getAudioOptions: reanimeMod.getAudioOptions   },
];

// Core is the recommended default — Megaplay embed with sub + dub.
export const DEFAULT_PROVIDER = "core";

// Human-readable labels — short, single-word, matching the hardcoded tabs.
export const PROVIDER_LABELS = {
  core:      "Core",
  vidstream: "VidStream",
  aninico:   "AniNico",
  reanime:   "ReAnime",
};

// Fallback order — Core first (default/recommended), then VidStream,
// then AniNico (the only one with hsub), then ReAnime (direct flixcloud).
const FALLBACK_ORDER = ["core", "vidstream", "aninico", "reanime"];

function getProvider(name) {
  return PROVIDERS.find((p) => p.name === name) ?? null;
}

// Route a direct HLS/mp4 URL through our own same-origin proxy (see
// routes/proxy.ts) so the browser doesn't need to (and can't) set a custom
// Referer header itself. The URL is signed (see core/proxy-sign.js) so the
// proxy can trust it regardless of which random CDN hostname the provider
// mirror happened to hand out this time.
function buildProxiedUrl(url, referer) {
  return signProxyUrl(url, referer);
}

/**
 * Pull a direct HLS URL (+ referer, if the entry carries one) out of any
 * provider's JSON response shape. Tags the result with its real `type` so
 * the caller knows whether it's an actual media URL (proxy it) or a
 * third-party embed page (use it as an iframe src instead — proxying an
 * HTML page through the HLS/media proxy just serves junk to the player,
 * which looked like a "stuck" server to the user).
 */
function extractStreamUrl(data) {
  if (typeof data.stream_url === "string" && data.stream_url.startsWith("http")) return { url: data.stream_url, referer: data.referer ?? null, type: "hls" };
  if (typeof data.url === "string" && data.url.startsWith("http")) return { url: data.url, referer: data.referer ?? null, type: "hls" };
  if (typeof data.hls === "string" && data.hls.startsWith("http")) return { url: data.hls, referer: data.referer ?? null, type: "hls" };
  if (typeof data.streamUrl === "string" && data.streamUrl.startsWith("http")) return { url: data.streamUrl, referer: data.referer ?? null, type: "hls" };

  const arr =
    Array.isArray(data.streams) ? data.streams :
    Array.isArray(data.links)   ? data.links   :
    Array.isArray(data.sources) ? data.sources : [];

  for (const s of arr) {
    if (s && (s.type === "hls" || (s.url && s.url.includes(".m3u8"))) && s.url) {
      return { url: s.url, referer: s.referer ?? null, type: "hls" };
    }
  }
  for (const s of arr) {
    if (s && typeof s.url === "string" && s.url.startsWith("http")) {
      return { url: s.url, referer: s.referer ?? null, type: s.type === "embed" ? "embed" : "hls" };
    }
  }
  return null;
}

function extractSubtitles(data) {
  if (Array.isArray(data.subtitles)) return data.subtitles;
  if (Array.isArray(data.tracks))    return data.tracks;
  return [];
}

const PROVIDER_TIMEOUT_MS = 18_000; // 18 s per provider

/**
 * Fetch a stream from exactly ONE named provider — no racing. The caller
 * (the UI's provider tabs) decides which provider to ask.
 *
 * @param {string} anilistId
 * @param {string} providerName  "core" | "vidstream" | "aninico" | "reanime"
 * @param {"sub"|"dub"|"hsub"} lang
 * @param {number} epNum
 * @returns {Promise<object|null>}
 */
async function fetchFromProvider(p, anilistId, lang, epNum) {
  const url = `http://localhost/watch/${p.name}/${anilistId}/${lang}/${p.name}-${epNum}`;
  try {
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
    const req   = new Request(url, { signal: ac.signal });
    let resp;
    try {
      resp = await p.handler.fetch(req, {});
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    const extracted = extractStreamUrl(data);
    if (!extracted) return null;
    const isEmbed = extracted.type === "embed";
    // Actual media URLs (HLS/mp4) always route through our own proxy — not
    // just when a referer is required. Some CDNs (AniZone's vid-cdn.xyz)
    // lock their Access-Control-Allow-Origin down to their own site, which
    // silently blocks the browser's fetch/hls.js requests with no
    // network-tab error obvious to the end user — routing everything
    // through our own same-origin proxy (which always sends
    // `Access-Control-Allow-Origin: *`) sidesteps that regardless of
    // whether the provider happens to need a Referer too.
    // Embed pages (VidWish, and AniDB/AniNeko's embed-only fallback) are
    // used as-is as an <iframe> src instead — proxying an HTML document
    // through the media proxy doesn't work and just looked "stuck".
    // Embed pages go through our own /api/embed-proxy so the upstream domain
    // (Koyeb, FlixCloud…) is never visible to the browser.
    const streamUrl = isEmbed
      ? buildEmbedProxyUrl(extracted.url)
      : buildProxiedUrl(extracted.url, extracted.referer);
    return {
      streamUrl,
      isEmbed,
      provider:    p.name,
      providerLabel: PROVIDER_LABELS[p.name] ?? p.name,
      artworkUrl:  data.thumbnail ?? data.poster ?? null,
      subtitles:   extractSubtitles(data),
      isHardSub:   false,
      currentLang: lang,
      languageName: data.languageName ?? null,
    };
  } catch {
    return null;
  }
}

export async function streamFromProvider(anilistId, providerName, lang, epNum) {
  const p = getProvider(providerName);
  if (!p) return null;
  return fetchFromProvider(p, anilistId, lang, epNum);
}

/**
 * Fetch a stream for the requested provider and audio track.
 *
 * NO CROSS-PROVIDER FALLBACK (per user spec):
 *   Each server stands on its own. If pop doesn't return a stream for the
 *   requested provider+audio, the UI shows "Stream Unavailable" — we do NOT
 *   silently switch to another server. The user picks the server explicitly,
 *   and switching behind their back is worse UX than showing "not available".
 *
 *   The ONLY internal fallback in the system is Core's /co endpoint, which
 *   fires inside core.js's handleWatch() when pop is unreachable — that's
 *   invisible to this function (Core always returns a non-null result when
 *   its /co fallback works).
 *
 *   Same-provider other-language fallback is preserved: if the user picked
 *   "dub" but the provider only has "sub" for this episode, we stay on the
 *   SAME provider and serve "sub" instead (flagged as `audioFallback: true`
 *   with `currentLang` set to whatever actually played).
 *
 * @returns {Promise<(object & { requestedProvider: string, switchedProvider: boolean, audioFallback?: boolean })|null>}
 */
export async function streamWithFallback(anilistId, providerName, lang, epNum) {
  const requested = getProvider(providerName);
  if (!requested) return null;

  const direct = await fetchFromProvider(requested, anilistId, lang, epNum);
  if (direct) return { ...direct, requestedProvider: providerName, switchedProvider: false };

  // Same-provider other-language fallback — stay on the SAME server, just
  // serve whatever audio it has for this episode instead of the requested
  // track. UI shows `audioFallback: true` + corrects the audio label.
  const otherLang = lang === "dub" ? "sub" : "dub";
  const sameProviderOtherLang = await fetchFromProvider(requested, anilistId, otherLang, epNum);
  if (sameProviderOtherLang) {
    return {
      ...sameProviderOtherLang,
      requestedProvider: providerName,
      switchedProvider: false,
      audioFallback: true,
    };
  }

  // NO cross-provider fallback — respect the user's server choice.
  // If the requested provider can't serve this episode, return null and let
  // the UI show "Stream Unavailable" with a "Switch Server" prompt.
  // (Core's /co fallback is handled inside core.js's handleWatch, invisible here.)
  return null;
}

/**
 * Real audio-track list for one provider + episode — used by the UI's
 * Audio picker so it only ever shows tracks that actually exist instead of
 * a hardcoded "Japanese / English" pair.
 */
export async function getAudioOptions(providerName, anilistId, epNum) {
  const p = getProvider(providerName);
  if (!p?.getAudioOptions) return [];
  try {
    return (await p.getAudioOptions(anilistId, Number(epNum))) ?? [];
  } catch {
    return [];
  }
}

/**
 * Find the first provider (in fallback order, current provider preferred)
 * whose real audio-option list contains `code` — used when the user picks
 * a language the current server doesn't have, so the UI can jump straight
 * to a server that does instead of guessing and failing.
 */
export async function findProviderForAudio(anilistId, epNum, code, preferredProvider) {
  const order = [preferredProvider, ...FALLBACK_ORDER.filter((n) => n !== preferredProvider)].filter(Boolean);
  for (const name of order) {
    const options = await getAudioOptions(name, anilistId, epNum);
    if (options.some((o) => o.code === code)) return name;
  }
  return null;
}
