// ─────────────────────────────────────────────────────────────────────────────
// DATA_SOURCE switch — controls whether catalog routes use AniList or MAL
// ─────────────────────────────────────────────────────────────────────────────
//
// Per user spec:
//   - DATA_SOURCE env var: "anilist" (default) | "mal"
//   - When "mal" + MAL_CLIENT_ID is set, catalog routes use MAL
//   - When "anilist" (or "mal" but no MAL_CLIENT_ID), fall back to AniList
//
// Stream/episode/skip-times routes are NOT affected — those always use
// AniList IDs + the /pop endpoint.

import { isMalEnabled } from "./client.js";

const DATA_SOURCE = (process.env.DATA_SOURCE || "anilist").toLowerCase().trim();

/**
 * Returns true if catalog routes should use MAL instead of AniList.
 * Checks both DATA_SOURCE=mal AND MAL_CLIENT_ID being set.
 */
export function useMalForCatalog(): boolean {
  return DATA_SOURCE === "mal" && isMalEnabled();
}

/** Source label for response introspection (used in some routes' `source` field). */
export function currentCatalogSource(): "anilist" | "mal" {
  return useMalForCatalog() ? "mal" : "anilist";
}
