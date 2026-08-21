// Shared /pop fetcher — single cache, single round-trip per episode.
//
// The /pop endpoint returns pre-checked stream URLs for every provider+audio
// combination the API knows about. Each provider module reads its own entry
// out of the response — no more per-provider probing or URL construction.
//
// URL: GET {EMBED_API_URL}/api/stream/anix.at/{anilistId}/{epNum}/pop
//
// Response shape:
//   {
//     "servers": [
//       { "provider": "default", "urls": { "sub": "...", "dub": "..." } },
//       { "provider": "vs",      "urls": { "sub": "...", "dub": "..." } },
//       { "provider": "am",      "urls": { "sub": "...", "dub": "...", "hsub": "..." } },
//       { "provider": "re",      "urls": { "sub": "https://flixcloud.cc/...", "dub": "..." } },
//       ...
//     ]
//   }
//
// The URLs already include the env-baked host — changing EMBED_API_URL on our
// backend changes BOTH the /pop call URL AND the URLs that /pop returns
// (because the pop API uses its own host when constructing them).
//
// The /pop endpoint has a built-in audio checker — it only lists URLs for
// audio tracks that actually exist. No need for us to probe separately.

const EMBED_API_URL = (process.env.EMBED_API_URL || "https://animani58hggktstisruarusrusrirustis.onrender.com")
  .replace(/\/+$/, "");

// ONE shared cache across all providers — fetching /pop for an episode once
// serves every provider's lookup.
const POP_CACHE = new Map(); // key → { data, expires }
const POP_TTL   = 10 * 60 * 1000; // 10 min for successful responses
const POP_ERR   = 60 * 1000;       // 1 min for failed responses (so a transient
                                   // 5xx doesn't poison the cache for 10 min)

/**
 * Fetch the /pop response for a given episode. Cached for 10 minutes on
 * success, 1 minute on failure. Returns null on any error so callers can
 * fall back to their own env-constructed URL.
 *
 * @param {string|number} anilistId
 * @param {string|number} epNum
 * @returns {Promise<object|null>} The parsed /pop response, or null.
 */
export async function fetchPop(anilistId, epNum) {
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

/**
 * Look up a specific provider's entry in the /pop response.
 *
 * @param {string|number} anilistId
 * @param {string|number} epNum
 * @param {string} providerId  e.g. "default", "vs", "am", "re"
 * @returns {Promise<object|null>}  The server entry ({ provider, name, urls })
 *                                   or null if /pop is down or has no entry.
 */
export async function getPopEntry(anilistId, epNum, providerId) {
  const pop = await fetchPop(anilistId, epNum);
  if (!pop?.servers) return null;
  return pop.servers.find((s) => s.provider === providerId) ?? null;
}

// Exported for tests / debugging
export const POP_EMBED_API_URL = EMBED_API_URL;
