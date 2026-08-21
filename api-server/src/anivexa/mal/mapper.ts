// ─────────────────────────────────────────────────────────────────────────────
// MAL → AniList response mapper
// ─────────────────────────────────────────────────────────────────────────────
//
// This module maps MAL API responses to the EXACT SAME response shape the
// AniList routes return today. The frontend code never changes — when
// DATA_SOURCE=mal, the backend calls MAL instead of AniList, then runs the
// response through this mapper before returning it to the frontend.
//
// Frontend expects (per the existing routes):
//   Card shape:
//     { id: anilistId, title, posterUrl, type: "TV"|"MOVIE"|"OVA"|...,
//       year: number|null }
//
//   Home shape:
//     { hero: HeroItem[], sections: [{ title, items: Card[] }] }
//
//   Details shape (per /api/anime/:id/details):
//     { id, malId, title, romaji, titleNative, description, posterUrl,
//       bannerUrl, genres[], type, year, status, episodeCount, rating,
//       studio, nextAiring: { episode, airsAt } | null }
//
//   Seasons shape (per /api/anime/:id/seasons):
//     { seasons: [{ id, title, isCurrent, posterUrl, type, episodes,
//                    status, year }] }
//
//   Browse shape (per /api/browse):
//     { items: Card[], hasNextPage, total }
//
//   Search shape (per /api/anime/search):
//     { results: Card[] }
//
//   Upcoming shape (per /api/upcoming):
//     { items: Card[] }
//
// CRITICAL: every `id` field is the AniList ID (not the MAL ID) — so the
// frontend URLs stay /anime/:anilistId and /watch/:anilistId/:epId.

import type { MalAnimeNode } from "./client.js";
import { malIdsToAnilistIds, anilistIdToMalId, malIdToAnilistId } from "./id-lookup.js";

// ── MAL → card shape (used everywhere we show a list of cards) ───────────────

/** Translate MAL media_type ("tv"|"movie"|"ova"|"ona"|"special"|"music") → AniList format ("TV"|"MOVIE"|...). */
function mapMediaType(malType: string | undefined): string | null {
  if (!malType) return null;
  const t = malType.toLowerCase();
  if (t === "tv") return "TV";
  if (t === "movie") return "MOVIE";
  if (t === "ova") return "OVA";
  if (t === "ona") return "ONA";
  if (t === "special") return "SPECIAL";
  if (t === "music") return "MUSIC";
  if (t === "tv_special") return "SPECIAL"; // MAL has tv_special — treat as Special
  if (t === "cm" || t === "pv" || t === "tv_special") return "SPECIAL";
  return malType.toUpperCase();
}

/** Translate MAL status ("finished_airing"|"currently_airing"|"not_yet_aired") → AniList ("FINISHED"|"RELEASING"|"NOT_YET_RELEASED"). */
function mapStatus(malStatus: string | undefined): string | null {
  if (!malStatus) return null;
  const s = malStatus.toLowerCase();
  if (s === "finished_airing" || s === "finished") return "FINISHED";
  if (s === "currently_airing" || s === "airing") return "RELEASING";
  if (s === "not_yet_aired" || s === "upcoming") return "NOT_YET_RELEASED";
  return malStatus.toUpperCase();
}

/** Pick the best poster URL from MAL's main_picture. */
function pickPoster(node: MalAnimeNode): string {
  return node.main_picture?.large ?? node.main_picture?.medium ?? "";
}

/** Pick the best title (english preferred, fallback to romaji/title). */
function pickTitle(node: MalAnimeNode): string {
  // MAL's `title` is usually romaji; alternative_titles.en is the English title
  return node.alternative_titles?.en || node.title || "";
}

/** Pick the year from MAL's start_season. */
function pickYear(node: MalAnimeNode): number | null {
  return node.start_season?.year ?? null;
}

/** Normalize MAL score (0-10 scale) to match AniList's 0-100 scale (we store /10). */
function mapScore(malMean: number | null | undefined): number | null {
  if (malMean == null) return null;
  return +(malMean).toFixed(1);
}

/** Strip HTML from a string (MAL synopsis sometimes has <br> tags). */
function stripHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/<[^>]*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Public mappers ───────────────────────────────────────────────────────────

export interface AnimeCard {
  id: number; title: string; posterUrl: string;
  type: string | null; year: number | null;
}

export interface HeroItem extends AnimeCard {
  status: string | null; rating: number | null;
  description: string; bannerUrl: string | null;
  genres: string[];
}

export interface AnimeDetails {
  id: number; malId: number | null;
  title: string; romaji: string | null; titleNative: string | null;
  description: string; posterUrl: string; bannerUrl: string | null;
  genres: string[]; type: string | null; year: number | null;
  status: string | null; episodeCount: number | null;
  rating: number | null; studio: string | null;
  nextAiring: { episode: number; airsAt: number } | null;
}

export interface SeasonEntry {
  id: number; title: string; isCurrent: boolean;
  posterUrl: string; type: string | null;
  episodes: number | null; status: string | null; year: number | null;
}

export interface BrowseResult {
  items: AnimeCard[]; hasNextPage: boolean; total: number;
}

/**
 * Map a single MAL node to a frontend Card shape.
 * Caller provides the AniList ID (since the mapper doesn't do ID translation).
 */
function nodeToCard(node: MalAnimeNode, anilistId: number): AnimeCard {
  return {
    id: anilistId,
    title: pickTitle(node),
    posterUrl: pickPoster(node),
    type: mapMediaType(node.media_type),
    year: pickYear(node),
  };
}

/**
 * Map an array of MAL nodes to frontend Card[] — translates every MAL ID to
 * its AniList ID in parallel. Nodes whose AniList ID can't be found are
 * SKIPPED (we never expose a MAL ID to the frontend).
 */
export async function malNodesToCards(nodes: MalAnimeNode[]): Promise<AnimeCard[]> {
  const anilistIds = await malIdsToAnilistIds(nodes.map((n) => n.id));
  const cards: AnimeCard[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const alId = anilistIds[i];
    if (alId == null) continue; // skip — no AniList ID found
    cards.push(nodeToCard(nodes[i]!, alId));
  }
  return cards;
}

/** Map a single MAL node to a HeroItem (richer card for the homepage hero). */
function nodeToHero(node: MalAnimeNode, anilistId: number): HeroItem {
  return {
    ...nodeToCard(node, anilistId),
    status: mapStatus(node.status),
    rating: mapScore(node.mean),
    description: stripHtml(node.synopsis),
    bannerUrl: node.pictures?.[0]?.large ?? pickPoster(node),
    genres: (node.genres ?? []).map((g) => g.name),
  };
}

/** Map top-N MAL nodes (from ranking) to HeroItem[] for the homepage hero section. */
export async function malNodesToHeroes(nodes: MalAnimeNode[]): Promise<HeroItem[]> {
  const anilistIds = await malIdsToAnilistIds(nodes.map((n) => n.id));
  const heroes: HeroItem[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const alId = anilistIds[i];
    if (alId == null) continue;
    heroes.push(nodeToHero(nodes[i]!, alId));
  }
  return heroes;
}

/**
 * Map a MAL detail node to the frontend AnimeDetails shape.
 * The caller passes the AniList ID (since they had to look it up to get
 * the MAL ID in the first place).
 *
 * NOTE: episodeCount is read from MAL's num_episodes field. When MAL returns
 * 0 (often for ongoing series with unknown episode counts — e.g., One Piece
 * shows 0 on MAL but 1174 on AniList), the caller should fall back to the
 * AniList value. We surface this by returning episodeCount = null when MAL
 * says 0 — the details route's fallback handles the rest.
 */
export async function malNodeToDetails(
  node: MalAnimeNode,
  anilistId: number,
): Promise<AnimeDetails> {
  return {
    id: anilistId,
    malId: node.id,
    title: pickTitle(node),
    romaji: node.title,                              // MAL `title` is usually romaji
    titleNative: node.alternative_titles?.ja ?? null,
    description: stripHtml(node.synopsis),
    posterUrl: pickPoster(node),
    bannerUrl: node.pictures?.[0]?.large ?? pickPoster(node),
    genres: (node.genres ?? []).map((g) => g.name),
    type: mapMediaType(node.media_type),
    year: pickYear(node),
    status: mapStatus(node.status),
    // MAL often returns 0 episodes for ongoing series (One Piece shows 0 on
    // MAL but 1174 on AniList). Surface null when MAL says 0 — the caller
    // (details route) falls back to AniList's count.
    episodeCount: node.num_episodes && node.num_episodes > 0 ? node.num_episodes : null,
    rating: mapScore(node.mean),
    studio: node.studios?.[0]?.name ?? null,
    // MAL doesn't have a "nextAiringEpisode" field — anime scheduled to air
    // have status="not_yet_aired" but no countdown. Leave nextAiring null.
    nextAiring: null,
  };
}

/**
 * Map MAL related_anime to the frontend Seasons shape.
 * Filters to SEQUEL/PREQUEL/SIDE_STORY relations (per AniList's filter).
 */
export async function malRelatedToSeasons(
  related: { node: MalAnimeNode; relationType: string }[],
  currentAnilistId: number,
): Promise<{ seasons: SeasonEntry[] }> {
  // Filter to sequel/prequel/side_story — match AniList's existing filter
  const KEEP_RELATIONS = new Set([
    "sequel", "prequel", "side_story", "parent_story", "alternative_version",
  ]);
  const filtered = related.filter((r) => KEEP_RELATIONS.has(r.relationType));

  // Map each related anime's MAL ID → AniList ID (parallel)
  const anilistIds = await malIdsToAnilistIds(filtered.map((r) => r.node.id));

  const seasons: SeasonEntry[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const alId = anilistIds[i];
    if (alId == null) continue; // skip — no AniList ID
    const node = filtered[i]!.node;
    seasons.push({
      id: alId,
      title: pickTitle(node),
      isCurrent: alId === currentAnilistId,
      posterUrl: pickPoster(node),
      type: mapMediaType(node.media_type),
      episodes: node.num_episodes ?? null,
      status: mapStatus(node.status),
      year: pickYear(node),
    });
  }
  return { seasons };
}

/**
 * Get the MAL ID for an AniList ID + fetch MAL details.
 * Convenience helper for the /details route.
 * Returns null if the anime has no MAL ID or MAL returns 404.
 */
export async function fetchMalDetailsByAnilistId(
  anilistId: number,
  fetcher: (malId: number) => Promise<MalAnimeNode | null>,
): Promise<MalAnimeNode | null> {
  const malId = await anilistIdToMalId(anilistId);
  if (malId == null) return null;
  return fetcher(malId);
}

/**
 * Get the AniList ID for a MAL node + create a fallback Card.
 * Used when MAL returns an item but we need to confirm the AniList ID exists.
 * If no AniList ID is found, returns null (item is skipped).
 */
export async function malNodeWithAnilistId(
  node: MalAnimeNode,
): Promise<AnimeCard | null> {
  const alId = await malIdToAnilistId(node.id);
  if (alId == null) return null;
  return nodeToCard(node, alId);
}

// Re-export the ID lookup helpers so routes can use them directly
export { anilistIdToMalId, malIdToAnilistId, malIdsToAnilistIds };
