// ─────────────────────────────────────────────────────────────────────────────
// AniList ↔ MAL ID lookup
// ─────────────────────────────────────────────────────────────────────────────
//
// The user spec says "URL should be anilist everything should be anilist" —
// so the frontend URLs stay /anime/:anilistId and /watch/:anilistId/:epId
// forever. But when DATA_SOURCE=mal, we need to translate anilist_id → mal_id
// before calling the MAL API.
//
// Strategy:
//   1. Query AniList (one cheap GraphQL call) for the `idMal` field on the
//      Media — AniList has near-100% coverage for `idMal` on anime.
//   2. Cache the mapping permanently (AniList ID ↔ MAL ID never changes).
//   3. Reverse mapping (mal_id → anilist_id) is cached separately — used when
//      MAL returns a list of mal_ids (search/ranking/season) and we need to
//      map back to anilist_ids for the frontend URL.
//
// In the rare case AniList has no `idMal` for an anime, we fall back to
// returning the original AniList ID (which means: don't call MAL for this
// anime, just use AniList — handled by the caller).

const ANILIST_GRAPHQL = "https://graphql.anilist.co";

// ── Permanent caches ────────────────────────────────────────────────────────
// AniList ID → MAL ID (and reverse) never change once a mapping exists.
// Cache misses are also cached (negative cache, 1h) so we don't hammer AniList
// for unknown IDs.
const anilistToMal = new Map<number, number | null>();
const malToAnilist = new Map<number, number | null>();
const NEG_TTL = 60 * 60_000; // 1h negative cache
const negativeCache = new Map<number, number>(); // anilist_id → expires_at

// ── Batched lookup ──────────────────────────────────────────────────────────
// AniList's GraphQL API lets us fetch up to 50 anime ids in a single request
// via the `Page(media: {id_in: [...]})` query. We batch up to 50 ids per
// request to minimise API calls.
const BATCH_SIZE = 50;
let inflightBatch: Promise<void> | null = null;
const pendingIds = new Set<number>();

async function fetchIdsFromAniList(anilistIds: number[]): Promise<void> {
  if (anilistIds.length === 0) return;
  // AniList GraphQL Page.media(id_in: [...]) — returns Media for each ID.
  // Cap at BATCH_SIZE per request; if more, split into chunks.
  for (let i = 0; i < anilistIds.length; i += BATCH_SIZE) {
    const chunk = anilistIds.slice(i, i + BATCH_SIZE);
    const query = `
      query($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(id_in: $ids, type: ANIME) {
            id
            idMal
          }
        }
      }
    `;
    try {
      const res = await fetch(ANILIST_GRAPHQL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: { ids: chunk } }),
      });
      if (!res.ok) {
        // Mark all as null (negative cache) so we don't retry immediately
        for (const id of chunk) {
          anilistToMal.set(id, null);
          negativeCache.set(id, Date.now() + NEG_TTL);
        }
        continue;
      }
      const json = (await res.json()) as {
        data?: { Page?: { media?: { id: number; idMal?: number | null }[] } };
      };
      const media = json.data?.Page?.media ?? [];
      const found = new Map<number, number | null>();
      for (const m of media) found.set(m.id, m.idMal ?? null);

      for (const id of chunk) {
        const malId = found.get(id) ?? null;
        anilistToMal.set(id, malId);
        if (malId != null) malToAnilist.set(malId, id);
        negativeCache.set(id, Date.now() + NEG_TTL);
      }
    } catch {
      // Network error — negative cache the lot, don't crash
      for (const id of chunk) {
        anilistToMal.set(id, null);
        negativeCache.set(id, Date.now() + NEG_TTL);
      }
    }
  }
}

// Flush pending batched IDs in a single request
async function flushBatch(): Promise<void> {
  const ids = [...pendingIds];
  pendingIds.clear();
  if (ids.length === 0) return;
  await fetchIdsFromAniList(ids);
}

// Schedule a batched flush (small delay so multiple concurrent lookups coalesce)
function scheduleBatch(): Promise<void> {
  if (inflightBatch) return inflightBatch;
  inflightBatch = new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await flushBatch();
      } finally {
        inflightBatch = null;
        resolve();
      }
    }, 20); // 20ms — small enough to feel instant, big enough to coalesce
  });
  return inflightBatch;
}

/**
 * Translate an AniList ID → MAL ID.
 * Returns null if the anime has no MAL ID (rare, but possible for new/obscure
 * anime not yet on MAL). The caller should treat null as "use AniList for
 * this anime" — the data source switch falls through.
 *
 * Cached permanently. Concurrent calls for the same ID coalesce.
 */
export async function anilistIdToMalId(anilistId: number): Promise<number | null> {
  // Already cached?
  if (anilistToMal.has(anilistId)) return anilistToMal.get(anilistId) ?? null;

  // Negative-cached?
  const neg = negativeCache.get(anilistId);
  if (neg && neg > Date.now()) return null;

  // Add to pending batch + wait for flush
  pendingIds.add(anilistId);
  await scheduleBatch();

  return anilistToMal.get(anilistId) ?? null;
}

/**
 * Translate a MAL ID → AniList ID.
 * Used when MAL returns a list of mal_ids (search/ranking/season) and we
 * need anilist_ids for the frontend URLs.
 *
 * Strategy: query AniList for `Media(idMal: $malId)` — AniList supports
 * reverse lookup by MAL ID. Cached permanently.
 */
export async function malIdToAnilistId(malId: number): Promise<number | null> {
  if (malToAnilist.has(malId)) return malToAnilist.get(malId) ?? null;

  const query = `
    query($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        id
        idMal
      }
    }
  `;
  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { malId } }),
    });
    if (!res.ok) {
      malToAnilist.set(malId, null);
      return null;
    }
    const json = (await res.json()) as {
      data?: { Media?: { id: number; idMal?: number | null } | null };
    };
    const media = json.data?.Media;
    if (media?.id) {
      malToAnilist.set(malId, media.id);
      anilistToMal.set(media.id, malId);
      return media.id;
    }
  } catch {
    // fallthrough
  }
  malToAnilist.set(malId, null);
  return null;
}

/**
 * Batch translate a list of MAL IDs → AniList IDs.
 * Issues parallel lookups (each one is cached + dedup'd) and returns results
 * in the SAME ORDER as the input list. Missing mappings become null.
 *
 * Used by home/search/ranking endpoints where MAL returns a list of mal_ids
 * and we need anilist_ids for every card's URL.
 */
export async function malIdsToAnilistIds(malIds: number[]): Promise<(number | null)[]> {
  // Use Promise.all for parallelism — the cache means most lookups are instant
  return Promise.all(malIds.map((id) => malIdToAnilistId(id)));
}
