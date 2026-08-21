// ─────────────────────────────────────────────────────────────────────────────
// MAL API client — official myanimelist.net/v2 API
// ─────────────────────────────────────────────────────────────────────────────
//
// Auth: just the X-MAL-Client-ID header (no OAuth bearer needed for public
// data). Client ID is read from MAL_CLIENT_ID env var.
//
// Rate limit: MAL allows ~10 req/sec per IP+client. We add a 100ms minimum
// spacing + an SWR cache (5-15 min TTL) so most requests are instant cache
// hits and we never get close to the limit.
//
// All MAL responses are wrapped in a { data: [{ node: {...} }], paging: {...} }
// shape. Helpers here unwrap the node and translate to a flat array.
//
// IMPORTANT: MAL uses MAL IDs, not AniList IDs. The caller (id-lookup.ts)
// translates anilist_id ↔ mal_id at the boundary — this client is purely
// MAL-domain.
//
// Endpoint reference (all return JSON):
//   GET /v2/anime?q=...&limit=20           — search by title
//   GET /v2/anime/:mal_id?fields=...        — details by ID
//   GET /v2/anime/ranking?ranking_type=... — top anime (all/bypopularity/airing/favorite)
//   GET /v2/anime/season/:year/:season     — seasonal anime
//   GET /v2/anime/suggestions               — MAL "for you" recommendations (auth-only, skipped)

const MAL_API_BASE = "https://api.myanimelist.net/v2";

// Client ID — read once at startup. Empty = MAL disabled.
const MAL_CLIENT_ID = (process.env.MAL_CLIENT_ID || "").trim();

export function isMalEnabled(): boolean {
  return MAL_CLIENT_ID.length > 0;
}

// ── Rate limiter ─────────────────────────────────────────────────────────────
// MAL allows ~10 req/sec. We enforce 100ms minimum spacing between requests
// to stay safely under the limit even under burst load.
let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 100;

async function rateLimitedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - now);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastRequestAt = Date.now();
  return fetch(url, {
    ...opts,
    headers: {
      "X-MAL-Client-ID": MAL_CLIENT_ID,
      "Accept": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

// ── SWR cache (module-level, shared across all callers) ─────────────────────
interface CacheEntry<T> { data: T; expires: number; }
const cache = new Map<string, CacheEntry<unknown>>();

function mkCachedFetcher<T>(ttlMs: number, swrMs: number) {
  const inflight = new Map<string, Promise<T>>();

  async function doFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = cache.get(key);
    if (entry && now < entry.expires) {
      if (now - (entry.expires - ttlMs) > swrMs) {
        // Stale-while-revalidate: trigger background refresh, but return cached.
        if (!inflight.has(key)) {
          inflight.set(key, fetcher()
            .then((d) => { cache.set(key, { data: d, expires: now + ttlMs }); return d; })
            .catch((e) => { const c = cache.get(key); if (c) return c.data as T; throw e; })
            .finally(() => inflight.delete(key)));
        }
      }
      return entry.data as T;
    }
    if (inflight.has(key)) return inflight.get(key)!;
    const p = fetcher()
      .then((d) => { cache.set(key, { data: d, expires: now + ttlMs }); return d; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return doFetch;
}

// Different TTLs per data type (per MAL's documented cache rules of thumb):
const cached5min  = mkCachedFetcher(5 * 60_000, 2 * 60_000);   // search, season
const cached15min = mkCachedFetcher(15 * 60_000, 5 * 60_000);  // rankings, upcoming
const cached30min = mkCachedFetcher(30 * 60_000, 10 * 60_000); // details

// ── Response types ───────────────────────────────────────────────────────────
export interface MalAnimeNode {
  id: number;
  title: string;
  main_picture?: { medium?: string; large?: string } | null;
  alternative_titles?: { en?: string; ja?: string; synonyms?: string[] } | null;
  mean?: number | null;            // score (e.g. 8.49)
  rank?: number | null;
  popularity?: number | null;
  num_episodes?: number;
  status?: string;                 // "finished_airing" | "currently_airing" | "not_yet_aired"
  media_type?: string;             // "tv" | "movie" | "ova" | "ona" | "special" | "music"
  start_season?: { year: number; season: string } | null;
  start_date?: string | null;
  end_date?: string | null;
  synopsis?: string | null;
  background?: string | null;
  genres?: { id: number; name: string }[];
  studios?: { id: number; name: string }[];
  related_anime?: { node: MalAnimeNode; relation_type: string; relation_type_formatted: string }[];
  recommendations?: { node: MalAnimeNode }[];
  average_episode_duration?: number | null;
  rating?: string | null;          // "pg_13" | "r" etc.
  pictures?: { medium: string; large: string }[] | null;
  source?: string | null;          // "manga" | "original" etc.
}

interface MalListResponse {
  data: { node: MalAnimeNode; ranking?: { rank: number } }[];
  paging?: { next?: string | null; previous?: string | null } | null;
}

// ── Field sets ───────────────────────────────────────────────────────────────
// We request only what we need — MAL lets us pick fields via the `fields` param.
const CARD_FIELDS =
  "id,title,main_picture,mean,num_episodes,media_type,start_season,status";
const DETAIL_FIELDS =
  "id,title,main_picture,alternative_titles,mean,num_episodes,media_type,status,start_season,start_date,end_date,synopsis,background,genres,studios,related_anime,recommendations,average_episode_duration,rating,source,pictures";

// ── Public API ───────────────────────────────────────────────────────────────

/** Search anime by title. Returns MAL nodes (caller must map to frontend card shape). */
export async function malSearch(query: string, limit = 20): Promise<MalAnimeNode[]> {
  if (!isMalEnabled()) return [];
  const url = `${MAL_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=${limit}&fields=${CARD_FIELDS}`;
  const key = `mal:search:${query.toLowerCase()}:${limit}`;
  return cached5min<MalAnimeNode[]>(key, async () => {
    const r = await rateLimitedFetch(url);
    if (!r.ok) throw new Error(`MAL search HTTP ${r.status}`);
    const d = (await r.json()) as MalListResponse;
    return d.data.map((x) => x.node);
  });
}

/** Get anime details by MAL ID. */
export async function malDetails(malId: number): Promise<MalAnimeNode | null> {
  if (!isMalEnabled()) return null;
  const url = `${MAL_API_BASE}/anime/${malId}?fields=${DETAIL_FIELDS}`;
  const key = `mal:detail:${malId}`;
  return cached30min<MalAnimeNode | null>(key, async () => {
    const r = await rateLimitedFetch(url);
    if (!r.ok) {
      if (r.status === 404) return null;
      throw new Error(`MAL detail HTTP ${r.status}`);
    }
    return (await r.json()) as MalAnimeNode;
  });
}

/**
 * Get top anime by ranking type.
 * @param rankingType "all" | "bypopularity" | "airing" | "favorite" | "tv" | "movie" | "ova" | "special"
 */
export async function malRanking(
  rankingType: string = "bypopularity",
  limit = 20,
): Promise<MalAnimeNode[]> {
  if (!isMalEnabled()) return [];
  const url = `${MAL_API_BASE}/anime/ranking?ranking_type=${rankingType}&limit=${limit}&fields=${CARD_FIELDS}`;
  const key = `mal:ranking:${rankingType}:${limit}`;
  return cached15min<MalAnimeNode[]>(key, async () => {
    const r = await rateLimitedFetch(url);
    if (!r.ok) throw new Error(`MAL ranking HTTP ${r.status}`);
    const d = (await r.json()) as MalListResponse;
    return d.data.map((x) => x.node);
  });
}

/**
 * Get seasonal anime for a year/season.
 * @param season "winter" | "spring" | "summer" | "fall"
 */
export async function malSeason(
  year: number,
  season: string,
  limit = 20,
  sort = "users",
): Promise<MalAnimeNode[]> {
  if (!isMalEnabled()) return [];
  const url = `${MAL_API_BASE}/anime/season/${year}/${season}?sort=${sort}&limit=${limit}&fields=${CARD_FIELDS}`;
  const key = `mal:season:${year}:${season}:${limit}`;
  return cached15min<MalAnimeNode[]>(key, async () => {
    const r = await rateLimitedFetch(url);
    if (!r.ok) throw new Error(`MAL season HTTP ${r.status}`);
    const d = (await r.json()) as MalListResponse;
    return d.data.map((x) => x.node);
  });
}

/** Get suggestions for an anime (MAL `recommendations` field, populated in details response). */
export function malRecommendations(detail: MalAnimeNode): MalAnimeNode[] {
  return detail.recommendations?.map((r) => r.node) ?? [];
}

/** Get related anime (MAL `related_anime` field, populated in details response). */
export function malRelatedAnime(detail: MalAnimeNode): { node: MalAnimeNode; relationType: string }[] {
  return detail.related_anime?.map((r) => ({ node: r.node, relationType: r.relation_type })) ?? [];
}

// Exported for tests / debugging.
export const _internal = { MAL_API_BASE, MAL_CLIENT_ID };
