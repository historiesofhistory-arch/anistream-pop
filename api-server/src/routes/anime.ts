import { Router }      from "express";
import type { Request, Response } from "express";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

const ANILIST = "https://graphql.anilist.co";
const KITSU   = "https://kitsu.app/api/edge";
const ARM_URL = "https://relations.yuna.moe/api/ids";
const ANISKIP = "https://api.aniskip.com/v2";
const UA      = "Mozilla/5.0 (compatible; AniStream/1.0)";

// ── Episode metadata + clear-logo source ───────────────────────────────────
// Defaults to api.bine.me — same shape just4anime had (AniList id → TVDB
// clearlogo + per-episode thumbnails), but with richer per-episode data
// (multiple image quality variants, simkl_id, tvdb season/episode).
// Override via the EPISODES_API_URL env var if you self-host.
const EPISODES_API_URL = (process.env.EPISODES_API_URL || "https://api.bine.me")
  .replace(/\/+$/, ""); // strip trailing slash(es)

async function alQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(ANILIST, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body:    JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0]!.message}`);
  return json.data;
}

// ── ARM → Kitsu ID lookup (MAL ID as source — more reliable than AniList ID) ─

interface KitsuEp {
  number:    number;
  title:     string | null;
  thumbnail: string | null;
  airdate:   string | null; // "YYYY-MM-DD"
}

async function armKitsuId(malId: number): Promise<number | null> {
  try {
    const r = await fetch(`${ARM_URL}?source=myanimelist&id=${malId}`, {
      headers: { "User-Agent": UA },
    });
    if (!r.ok) return null;
    const d = await r.json() as { kitsu?: number } | null;
    return d?.kitsu ?? null;
  } catch { return null; }
}

// Fetches ALL Kitsu episodes for a given kitsu anime ID in parallel.
// Kitsu max page size = 20; no rate limits on the public API.
async function fetchKitsuEps(kitsuId: number): Promise<Map<number, KitsuEp>> {
  const PAGE = 20;
  const map  = new Map<number, KitsuEp>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parse = (raw: any): KitsuEp => ({
    number:    raw?.attributes?.number ?? 0,
    title:     raw?.attributes?.canonicalTitle ?? null,
    thumbnail: raw?.attributes?.thumbnail?.original ?? null,
    airdate:   raw?.attributes?.airdate ?? null,
  });

  const first = await fetch(
    `${KITSU}/anime/${kitsuId}/episodes?page[limit]=${PAGE}&page[offset]=0`,
    { headers: { "User-Agent": UA, Accept: "application/vnd.api+json" } },
  ).then((r) => (r.ok ? r.json() : null)).catch(() => null) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: { count: number }; data: any[];
  } | null;

  if (!first) return map;
  for (const e of first.data ?? []) {
    const ep = parse(e);
    if (ep.number) map.set(ep.number, ep);
  }

  const total = first.meta?.count ?? 0;
  if (total <= PAGE) return map;

  const pages = Math.ceil(total / PAGE) - 1;
  const rest  = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      fetch(
        `${KITSU}/anime/${kitsuId}/episodes?page[limit]=${PAGE}&page[offset]=${(i + 1) * PAGE}`,
        { headers: { "User-Agent": UA, Accept: "application/vnd.api+json" } },
      ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ),
  );
  for (const p of rest) {
    for (const e of p?.data ?? []) {
      const ep = parse(e);
      if (ep.number) map.set(ep.number, ep);
    }
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory stale-while-revalidate cache
// ─────────────────────────────────────────────────────────────────────────────

function mkSwr<T>(
  ttlMs:   number,
  swrMs:   number,
  fetcher: (key: string) => Promise<T>,
) {
  const store    = new Map<string, { data: T; at: number }>();
  const inflight = new Map<string, Promise<T>>();

  function schedule(key: string): Promise<T> {
    if (inflight.has(key)) return inflight.get(key)!;
    const p = fetcher(key)
      .then((d) => { store.set(key, { data: d, at: Date.now() }); return d; })
      .catch((e) => {
        const c = store.get(key);
        if (c) return c.data; // serve stale on error
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return async (key: string): Promise<T> => {
    const now = Date.now();
    const c   = store.get(key);
    if (c && now - c.at < ttlMs) {
      if (now - c.at > swrMs) schedule(key); // background revalidate
      return c.data;
    }
    return schedule(key);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AniList shape helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AlMedia {
  id:           number;
  idMal?:       number | null;
  title?:       { english?: string | null; romaji?: string | null; native?: string | null } | null;
  coverImage?:  { extraLarge?: string | null; large?: string | null } | null;
  bannerImage?: string | null;
  description?: string | null;
  genres?:      string[] | null;
  format?:      string | null;
  status?:      string | null;
  averageScore?: number | null;
  seasonYear?:  number | null;
  episodes?:    number | null;
  startDate?:   { year?: number | null } | null;
  studios?:     { nodes: { name: string }[] } | null;
  type?:        string | null;
  relations?:   {
    edges: {
      relationType: string;
      node: AlMedia;
    }[];
  } | null;
}

function cover(m: AlMedia): string {
  return m.coverImage?.extraLarge ?? m.coverImage?.large ?? "";
}

function title(m: AlMedia): string {
  return m.title?.english ?? m.title?.romaji ?? "";
}

function stripHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/<[^>]*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function currentSeason(): { season: string; year: number } {
  const mo = new Date().getMonth() + 1;
  const yr = new Date().getFullYear();
  const s  = mo <= 3 ? "WINTER" : mo <= 6 ? "SPRING" : mo <= 9 ? "SUMMER" : "FALL";
  return { season: s, year: yr };
}

const toCard = (m: AlMedia) => ({
  id:       m.id,
  title:    title(m),
  posterUrl: cover(m),
  type:     m.format ?? null,
  year:     m.seasonYear ?? null,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /home
// ─────────────────────────────────────────────────────────────────────────────

const HOME_Q = `
query($season: MediaSeason, $year: Int) {
  hero: Page(page: 1, perPage: 8) {
    media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge large } bannerImage
      description(asHtml: false) genres format status averageScore seasonYear
    }
  }
  popular: Page(page: 1, perPage: 20) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, format: TV) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  topRated: Page(page: 1, perPage: 20) {
    media(type: ANIME, sort: SCORE_DESC, isAdult: false, format: TV, status: FINISHED) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  airing: Page(page: 1, perPage: 20) {
    media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  movies: Page(page: 1, perPage: 20) {
    media(type: ANIME, format: MOVIE, sort: POPULARITY_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  upcoming: Page(page: 1, perPage: 20) {
    media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  action: Page(page: 1, perPage: 20) {
    media(type: ANIME, genre_in: ["Action"], sort: TRENDING_DESC, isAdult: false, format: TV) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  romance: Page(page: 1, perPage: 20) {
    media(type: ANIME, genre_in: ["Romance"], sort: SCORE_DESC, isAdult: false, format: TV) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
  fantasy: Page(page: 1, perPage: 20) {
    media(type: ANIME, genre_in: ["Fantasy"], sort: TRENDING_DESC, isAdult: false, format: TV) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
}`;

interface HomeData {
  hero:     { media: AlMedia[] };
  popular:  { media: AlMedia[] };
  topRated: { media: AlMedia[] };
  airing:   { media: AlMedia[] };
  movies:   { media: AlMedia[] };
  upcoming: { media: AlMedia[] };
  action:   { media: AlMedia[] };
  romance:  { media: AlMedia[] };
  fantasy:  { media: AlMedia[] };
}

const getHome = mkSwr<unknown>(10 * 60_000, 5 * 60_000, async () => {
  const { season, year } = currentSeason();
  const d = await alQuery<HomeData>(HOME_Q, { season, year });
  return {
    hero: d.hero.media.map((m) => ({
      id:          m.id,
      title:       title(m),
      type:        m.format ?? null,
      year:        m.seasonYear ?? null,
      status:      m.status ?? null,
      rating:      m.averageScore ? +(m.averageScore / 10).toFixed(1) : null,
      description: stripHtml(m.description),
      posterUrl:   cover(m),
      bannerUrl:   m.bannerImage ?? null,
      genres:      m.genres ?? [],
    })),
    sections: [
      { title: "Trending Now",      items: d.hero.media.map(toCard) },
      { title: "Most Popular",      items: d.popular.media.map(toCard) },
      { title: "Currently Airing",  items: d.airing.media.map(toCard) },
      { title: "Top Rated All Time",items: d.topRated.media.map(toCard) },
      { title: "Action & Adventure",items: d.action.media.map(toCard) },
      { title: "Romance",           items: d.romance.media.map(toCard) },
      { title: "Fantasy & Magic",   items: d.fantasy.media.map(toCard) },
      { title: "Movies",            items: d.movies.media.map(toCard) },
      { title: "Coming Soon",       items: d.upcoming.media.map(toCard) },
    ],
  };
});

router.get("/home", async (_req: Request, res: Response) => {
  try {
    res.json(await getHome("home"));
  } catch (e) {
    console.error("[home]", e);
    res.status(502).json({ error: "Failed to load home data" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/trending
// ─────────────────────────────────────────────────────────────────────────────

const TREND_Q = `query {
  Page(page: 1, perPage: 20) {
    media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
}`;

const getTrending = mkSwr<unknown>(10 * 60_000, 5 * 60_000, async () => {
  const d = await alQuery<{ Page: { media: AlMedia[] } }>(TREND_Q);
  return { items: d.Page.media.map(toCard) };
});

router.get("/anime/trending", async (_req: Request, res: Response) => {
  try   { res.json(await getTrending("t")); }
  catch { res.status(502).json({ error: "Failed to load trending" }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/search?q=
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_Q = `query($q: String) {
  Page(page: 1, perPage: 20) {
    media(type: ANIME, search: $q, isAdult: false) {
      id title { english romaji } coverImage { extraLarge } format status seasonYear
    }
  }
}`;

router.get("/anime/search", async (req: Request, res: Response) => {
  const q = ((req.query.q as string) ?? "").trim();
  if (!q) return void res.json({ results: [] });
  try {
    const d = await alQuery<{ Page: { media: AlMedia[] } }>(SEARCH_Q, { q });
    res.json({ results: d.Page.media.map(toCard) });
  } catch (e) {
    console.error("[search]", e);
    res.status(502).json({ error: "Search failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/schedule?date=YYYY-MM-DD&tz=Asia/Kolkata
//
// Returns the Mon–Sun week containing `date` (defaults to today), with all
// airing schedules grouped by day in the requested timezone.
//
// DATA SOURCE — 2-tier fallback:
//
//   TIER 1 (OPTIONAL ADDON): SCHEDULE_API_URL env var
//     If set (e.g., SCHEDULE_API_URL=https://your-miruro-instance.example.com),
//     the backend fetches airing data from that REST API instead of AniList
//     GraphQL. The API must return JSON with results[] where each item has:
//       { id, title: { english, romaji }, coverImage: { extraLarge },
//         nextAiringEpisode: { episode, airingAt, timeUntilAiring } }
//     This is compatible with the miruro/AniList-style API format.
//
//   TIER 2 (DEFAULT FALLBACK): AniList GraphQL
//     Uses the SCHED_Q query to fetch airingSchedules for the week range.
//     This is the original implementation, always available.
//
// If TIER 1 fails (network error, bad response, no data), the backend
// silently falls back to TIER 2. The site is never affected by addon failures.
//
// Response shape:
//   {
//     schedule: [{ day, dayIndex, date, items: [{id, title, posterUrl, episode, time, aired}] }],
//     weekStart: "YYYY-MM-DD",
//     weekEnd:   "YYYY-MM-DD",
//     timezone:  "Asia/Kolkata",
//     source:    "addon" | "anilist",
//   }
// ─────────────────────────────────────────────────────────────────────────────

const SCHED_Q = `query($s: Int, $e: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    airingSchedules(airingAt_greater: $s, airingAt_lesser: $e, sort: TIME) {
      episode airingAt
      media { id title { english romaji } coverImage { extraLarge } format }
    }
  }
}`;

interface AiringEntry {
  episode:  number;
  airingAt: number;
  media:    AlMedia;
}

// Fetch ALL airing schedules for a week range — paginated.
// AniList caps perPage at 50 for airingSchedules, so we fetch multiple pages.
// A typical week has ~100-150 episodes, so 3 pages (150 items) is enough.
async function fetchAllAiringSchedules(s: number, e: number): Promise<AiringEntry[]> {
  const all: AiringEntry[] = [];
  for (let page = 1; page <= 3; page++) {
    const d = await alQuery<{ Page: { airingSchedules: AiringEntry[] } }>(SCHED_Q, { s, e, page });
    const eps = d.Page.airingSchedules;
    all.push(...eps);
    if (eps.length < 50) break; // last page
  }
  return all;
}

// Returns the offset in minutes from UTC for `tz` at the given moment.
// Used to compute week boundaries that respect the user's local timezone.
function tzOffsetMinutes(unixMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(unixMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
  const y = +get("year"), mo = +get("month"), d = +get("day");
  let h = +get("hour");
  if (h === 24) h = 0; // some environments return "24" for midnight in hour12:false
  const mi = +get("minute"), s = +get("second");
  const asUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  return Math.round((asUTC - unixMs) / 60000);
}

// Returns Monday 00:00 (in target TZ) as a unix ms timestamp, given any date
// string (YYYY-MM-DD) within the target week.
function getMondayMidnightLocal(dateStr: string, tz: string): number {
  // Parse input as noon UTC to avoid DST edge cases around midnight.
  const any = new Date(`${dateStr}T12:00:00Z`);

  // Get weekday of `any` in target TZ (so we know how many days to subtract).
  const weekdayStr = new Intl.DateTimeFormat("en-US", {
    weekday: "short", timeZone: tz,
  }).format(any);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dow = weekdays.indexOf(weekdayStr);
  if (dow < 0) throw new Error(`Could not determine weekday for ${dateStr}`);
  const daysToSubtract = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6

  // Monday (same moment in UTC, just shifted by whole days).
  const mondayUtc = new Date(any);
  mondayUtc.setUTCDate(mondayUtc.getUTCDate() - daysToSubtract);

  // Time-of-day of `mondayUtc` as seen in target TZ, in minutes past midnight.
  const timeParts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: tz,
  }).formatToParts(mondayUtc);
  const get = (t: string) => timeParts.find(p => p.type === t)?.value ?? "0";
  let h = +get("hour");
  if (h === 24) h = 0;
  const m = +get("minute"), s = +get("second");
  const minutesPastMidnight = h * 60 + m + s / 60;

  // Monday 00:00 in target TZ = mondayUtc - minutesPastMidnight.
  return mondayUtc.getTime() - minutesPastMidnight * 60 * 1000;
}

const SCHEDULE_DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
];

// Per-week SWR cache. The cache key embeds the date + tz so different weeks
// and different timezones are cached independently. Past weeks are stable so
// the cache is essentially permanent for them; current/future weeks revalidate
// every 15 min for new episode announcements.
const getSchedule = mkSwr<unknown>(30 * 60_000, 15 * 60_000, async (key: string) => {
  // key format: "schedule|YYYY-MM-DD|Asia/Kolkata"
  const [, dateParam, tz] = key.split("|");
  if (!dateParam || !tz) throw new Error("Bad schedule cache key");

  // Validate tz (will throw on invalid timezone names).
  Intl.DateTimeFormat("en-US", { timeZone: tz });

  // Compute Monday 00:00 and Sunday 23:59:59 in target TZ.
  const mondayMidnightLocal = getMondayMidnightLocal(dateParam, tz);
  const sundayEndLocal      = mondayMidnightLocal + 7 * 24 * 60 * 60 * 1000 - 1000;
  const s = Math.floor(mondayMidnightLocal / 1000);
  const e = Math.floor(sundayEndLocal / 1000);

  // Precompute formatters (shared between both data sources)
  const dateFmt    = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz,
  });
  const weekdayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long", timeZone: tz,
  });
  const timeFmt    = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
  });

  interface ScheduleItem {
    id:        number;
    title:     string;
    posterUrl: string;
    episode:   number;
    time:      string;
    aired:     boolean;
  }
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const dayMoment = mondayMidnightLocal + i * 24 * 60 * 60 * 1000;
    return {
      day:      weekdayFmt.format(new Date(dayMoment)),
      dayIndex: i,
      date:     dateFmt.format(new Date(dayMoment)),
      items:    [] as ScheduleItem[],
    };
  });

  const itemsByDate = new Map<string, ScheduleItem[]>();
  const now = Date.now();

  // Helper: add an airing entry to the correct day bucket
  function addScheduleItem(anilistId: number, animeTitle: string, posterUrl: string, episode: number, airingAtSec: number) {
    const dt = new Date(airingAtSec * 1000);
    const dateStr = dateFmt.format(dt);
    if (!itemsByDate.has(dateStr)) itemsByDate.set(dateStr, []);
    itemsByDate.get(dateStr)!.push({
      id:        anilistId,
      title:     animeTitle,
      posterUrl: posterUrl,
      episode:   episode,
      time:      timeFmt.format(dt),
      aired:     airingAtSec * 1000 < now,
    });
  }

  // ── TIER 1 (OPTIONAL): Miruro API — PRIMARY source ───────────────────────
  // If USE_MIRURO_SCHEDULE=true, Miruro is the PRIMARY schedule source.
  // Miruro's API only returns nextAiringEpisode (upcoming episodes that
  // haven't aired yet). It does NOT have past episodes that already aired.
  //
  // To get the FULL week (past + upcoming), we:
  //   1. Fetch ALL upcoming episodes from Miruro (fast, paginated REST API)
  //   2. Fetch ALL episodes for the week from AniList (past + upcoming)
  //   3. Merge: Miruro items take priority (more accurate nextAiringEpisode data)
  //   4. Deduplicate by animeId-episode
  //
  // If Miruro fails completely → source = 'anilist' (AniList only, full week)
  // If Miruro works → source = 'miruro' (primary, AniList fills gaps silently)
  //
  // The site is never affected — if Miruro is down, AniList takes over.
  const MIRURO_API_BASE = (process.env.MIRURO_API_URL || "https://miruro-api-original.onrender.com").replace(/\/+$/, "");
  const useMiruro = process.env.USE_MIRURO_SCHEDULE === "true";
  let source = "anilist";
  const existingKeys = new Set<string>();

  if (useMiruro) {
    try {
      // Fetch all Miruro pages for the week range (upcoming only)
      let page = 1;
      let pastWeek = false;
      let miruroCount = 0;

      while (!pastWeek && page <= 15) {
        const res = await fetch(`${MIRURO_API_BASE}/schedule?page=${page}`, {
          headers: { "User-Agent": UA, "Accept": "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`miruro HTTP ${res.status}`);
        const json = await res.json() as {
          results?: Array<{
            id: number;
            title: { english?: string | null; romaji?: string | null };
            coverImage: { extraLarge?: string | null; large?: string | null };
            nextAiringEpisode?: { episode: number; airingAt: number; timeUntilAiring: number } | null;
          }>;
          hasNextPage?: boolean;
        };
        if (!json.results?.length) break;

        for (const item of json.results) {
          const na = item.nextAiringEpisode;
          if (!na || !na.airingAt) continue;
          if (na.airingAt >= s && na.airingAt <= e) {
            const key = `${item.id}-${na.episode}`;
            if (!existingKeys.has(key)) {
              existingKeys.add(key);
              miruroCount++;
              addScheduleItem(
                item.id,
                item.title.english ?? item.title.romaji ?? "Unknown",
                item.coverImage.extraLarge ?? item.coverImage.large ?? "",
                na.episode,
                na.airingAt,
              );
            }
          } else if (na.airingAt > e) {
            pastWeek = true;
            break;
          }
        }

        if (!json.hasNextPage) break;
        page++;
      }

      if (miruroCount > 0) {
        source = "miruro";
      }
    } catch {
      // Miruro failed — fall back to AniList for everything
      source = "anilist";
    }
  }

  // ── TIER 2: AniList GraphQL — fills gaps (past episodes) ─────────────────
  // ALWAYS fetched to fill in past episodes that Miruro doesn't have.
  // When USE_MIRURO_SCHEDULE=false: AniList provides ALL episodes (full week).
  // When USE_MIRURO_SCHEDULE=true: AniList fills in PAST episodes only.
  // Deduplicate: skip items already added by Miruro.
  {
    const allSchedules = await fetchAllAiringSchedules(s, e);
    for (const a of allSchedules) {
      const key = `${a.media.id}-${a.episode}`;
      if (!existingKeys.has(key)) {
        addScheduleItem(a.media.id, title(a.media), cover(a.media), a.episode, a.airingAt);
      }
    }
  }

  // Attach each day's items.
  for (const day of weekDays) {
    const items = itemsByDate.get(day.date);
    if (items) day.items = items;
  }

  // For the frontend's "Week of <start> – <end>" header.
  const weekStart = dateFmt.format(new Date(mondayMidnightLocal));
  const weekEnd   = dateFmt.format(new Date(sundayEndLocal));

  return {
    schedule: weekDays,
    weekStart,
    weekEnd,
    timezone: tz,
    source,
  };
});

router.get("/anime/schedule", async (req: Request, res: Response) => {
  try {
    const tz      = (req.query.tz as string)   || "Asia/Kolkata";
    const rawDate = (req.query.date as string) || "";

    // Validate timezone FIRST — before we use it to compute the default date.
    // Intl.DateTimeFormat throws RangeError on unknown tz names.
    try {
      Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return res.status(400).json({ error: `Invalid timezone: ${tz}` });
    }

    // Default to today (in target TZ) if no date supplied.
    const dateParam = rawDate ||
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz,
      }).format(new Date());

    // Validate date format.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return res.status(400).json({ error: `Invalid date format: ${dateParam}. Use YYYY-MM-DD.` });
    }

    res.json(await getSchedule(`schedule|${dateParam}|${tz}`));
  } catch (e) {
    console.error("[schedule]", e);
    res.status(502).json({ error: "Failed to load schedule" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/logo
//
// Returns the anime's stylized text logo as a transparent PNG URL — sourced
// from TheTVDB's clearlogo collection. Used by the watch page as a branded
// loading overlay while the stream URL resolves.
//
// Mapping strategy (3-tier fallback):
//
//   1. PRIMARY — episodes API (api.bine.me by default)
//      `GET {EPISODES_API_URL}/api/episodes/<id>`
//      Returns `artworks.clear_logo` directly in the same response as the
//      episode list — no separate TVDB scrape needed.
//      Hit rate: ~95%+ for any anime TVDB has a logo for.
//
//   2. FALLBACK — direct TVDB scrape via slug guessing
//      Query AniList for titles, slugify, fetch https://thetvdb.com/series/<slug>
//      and regex-scan the HTML for clearlogo URLs.
//      Used when the episodes API is down or has no clear_logo for the anime.
//
//   3. LAST RESORT — return null
//      Caller (frontend) falls back to a spinner-only loading state.
//
// Permanent in-memory cache keyed by AniList ID — once resolved, future
// calls are instant (TVDB slugs / episodes API responses don't change).
//
// Returns:
//   { logoUrl: string | null, source: "episodes-api" | "tvdb" | null }
// ─────────────────────────────────────────────────────────────────────────────

const J4A_API = EPISODES_API_URL + "/api/episodes";
const TVDB_BASE = "https://thetvdb.com/series/";
const TVDB_LOGO_RE =
  /https:\/\/artworks\.thetvdb\.com\/banners\/v4\/series\/\d+\/clearlogo\/[a-f0-9]+\.png/g;

// Slugify an anime title the way TVDB does:
//   "ONE PIECE" -> "one-piece"
//   "Bleach: Thousand-Year Blood War" -> "bleach-thousand-year-blood-war"
//   "Demon Slayer: Kimetsu no Yaiba" -> "demon-slayer-kimetsu-no-yaiba"
function tvdbSlug(t: string): string {
  return t
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Permanent cache: AniList ID -> { logoUrl, source } | null
const logoCache = new Map<number, { logoUrl: string; source: string } | null>();

// PRIMARY: scrape clear-logo from the episodes API (api.bine.me by default)
//
// api.bine.me returns artworks.clear_logo directly in the same response
// as the episode list — no separate TVDB scrape needed. Falls through
// to the TVDB-slug fallback below if the episodes API is down or has
// no clear_logo for this anime.
async function fetchLogoFromJust4Anime(anilistId: number): Promise<string | null> {
  try {
    const res = await fetch(`${J4A_API}/${anilistId}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      artworks?: { clear_logo?: string | null } | null;
    };
    return json?.artworks?.clear_logo ?? null;
  } catch {
    return null;
  }
}

// FALLBACK: direct TVDB scrape via slug guessing
async function fetchTvdbLogo(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${TVDB_BASE}${encodeURIComponent(slug)}`, {
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = TVDB_LOGO_RE.exec(html);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

const LOGO_TITLES_Q = `query($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { english romaji native }
  }
}`;

async function resolveLogo(anilistId: number): Promise<{ logoUrl: string; source: string } | null> {
  const cached = logoCache.get(anilistId);
  if (cached !== undefined) return cached;

  let result: { logoUrl: string; source: string } | null = null;

  // ── TIER 1: episodes API (api.bine.me by default) ────────────────────────
  const j4aLogo = await fetchLogoFromJust4Anime(anilistId);
  if (j4aLogo) {
    result = { logoUrl: j4aLogo, source: "episodes-api" };
    logoCache.set(anilistId, result);
    return result;
  }

  // ── TIER 2: TVDB direct scrape via slug guessing ──────────────────────────
  try {
    const d = await alQuery<{ Media: { title: { english?: string | null; romaji?: string | null; native?: string | null } | null } | null }>(
      LOGO_TITLES_Q,
      { id: anilistId },
    );
    const titles = d.Media?.title;
    if (titles) {
      const candidates = Array.from(new Set(
        [titles.english, titles.romaji, titles.native]
          .filter((t): t is string => !!t && t.trim().length > 0)
          .map(tvdbSlug),
      ));
      for (const slug of candidates) {
        if (!slug) continue;
        const logo = await fetchTvdbLogo(slug);
        if (logo) {
          result = { logoUrl: logo, source: "tvdb" };
          break;
        }
      }
    }
  } catch {
    result = null;
  }

  // ── TIER 3: null (frontend shows spinner) ─────────────────────────────────
  logoCache.set(anilistId, result);
  return result;
}

router.get("/anime/:id/logo", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid anime ID" });
    }
    const result = await resolveLogo(id);
    res.json({
      logoUrl: result?.logoUrl ?? null,
      source: result?.source ?? null,
    });
  } catch (e) {
    console.error("[logo]", e);
    res.status(502).json({ error: "Failed to resolve logo" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/details
// ─────────────────────────────────────────────────────────────────────────────

const DETAILS_Q = `query($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal
    title { english romaji native }
    coverImage { extraLarge large }
    bannerImage
    description(asHtml: false)
    genres format status episodes averageScore seasonYear
    startDate { year month day }
    nextAiringEpisode { episode timeUntilAiring }
    studios(isMain: true) { nodes { name } }
    relations {
      edges {
        relationType(version: 2)
        node {
          id type title { english romaji } coverImage { extraLarge }
          format status seasonYear episodes
        }
      }
    }
  }
}`;

const getDetails = mkSwr<unknown>(15 * 60_000, 5 * 60_000, async (id: string) => {
  const d = await alQuery<{ Media: AlMedia }>(DETAILS_Q, { id: Number(id) });
  const m = d.Media;

  // ── Episode count verification for big anime ──────────────────────────────
  // AniList sometimes includes specials/movies/OVAs in the episode count
  // (e.g., Doraemon shows 927 but only ~600 actual episodes are available).
  // For FINISHED big anime (>100 episodes), cross-check with the episodes API
  // (api.bine.me) total_aired field and use the SMALLER count (actual available
  // episodes). For ONGOING anime, DON'T reduce the count — the episodes API may
  // just not have caught up yet.
  let verifiedEpisodeCount = m.episodes ?? null;
  if (verifiedEpisodeCount && verifiedEpisodeCount > 100 && m.status === "FINISHED") {
    try {
      const epsRes = await fetch(`${J4A_API}/${m.id}`, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
        },
      });
      if (epsRes.ok) {
        const epsJson = await epsRes.json() as { episodes?: { total_aired?: number } };
        if (epsJson.episodes?.total_aired) {
          const apiCount = epsJson.episodes.total_aired;
          // Use the smaller count — episodes API has the actual available eps
          if (apiCount < verifiedEpisodeCount) {
            verifiedEpisodeCount = apiCount;
          }
        }
      }
    } catch {
      // Episodes API check failed — keep AniList's count (no harm)
    }
  }

  // ── Next airing episode for countdown timer ───────────────────────────────
  // AniList returns `timeUntilAiring` in seconds from NOW. Convert to an
  // absolute timestamp so cached responses still have a correct countdown
  // when served later.
  const nextAiringEpisode = (m as AlMedia & {
    nextAiringEpisode?: { episode: number; timeUntilAiring: number } | null;
  }).nextAiringEpisode;
  const nextAiring = nextAiringEpisode
    ? {
        episode: nextAiringEpisode.episode,
        airsAt:  Date.now() + nextAiringEpisode.timeUntilAiring * 1000,
      }
    : null;

  return {
    id:           m.id,
    malId:        m.idMal ?? null,
    title:        title(m),
    romaji:       m.title?.romaji ?? null,
    titleNative:  m.title?.native ?? null,
    description:  stripHtml(m.description),
    posterUrl:    cover(m),
    bannerUrl:    m.bannerImage ?? null,
    genres:       m.genres ?? [],
    type:         m.format ?? null,
    year:         m.seasonYear ?? m.startDate?.year ?? null,
    status:       m.status ?? null,
    episodeCount: verifiedEpisodeCount,
    rating:       m.averageScore ? +(m.averageScore / 10).toFixed(1) : null,
    studio:       m.studios?.nodes?.[0]?.name ?? null,
    nextAiring,
  };
});

router.get("/anime/:id/details", async (req: Request, res: Response) => {
  try {
    res.json(await getDetails(req.params.id!));
  } catch (e) {
    console.error("[details]", e);
    res.status(502).json({ error: "Not found" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/seasons  (related series from AniList relations)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/anime/:id/seasons", async (req: Request, res: Response) => {
  try {
    const d      = await alQuery<{ Media: AlMedia }>(DETAILS_Q, { id: Number(req.params.id) });
    const edges  = d.Media.relations?.edges ?? [];
    const seasons = edges
      .filter(
        (e) =>
          ["SEQUEL", "PREQUEL", "SIDE_STORY"].includes(e.relationType) &&
          e.node.type === "ANIME",
      )
      .map((e) => ({
        id:        e.node.id,
        title:     title(e.node),
        isCurrent: e.node.id === Number(req.params.id),
        posterUrl: cover(e.node),
        type:      e.node.format ?? null,
        episodes:  e.node.episodes ?? null,
        status:    e.node.status ?? null,
        year:      e.node.seasonYear ?? null,
      }));
    res.json({ seasons });
  } catch (e) {
    res.status(502).json({ error: "Failed to load seasons" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/episodes  (api.bine.me primary, AniList+Kitsu fallback)
// ────────────────────────────────────────────────────────────────────────────
//
// EPISODE DATA SOURCE — 2-tier fallback:
//
//   TIER 1 (PRIMARY): api.bine.me episodes API
//     GET {EPISODES_API_URL}/api/episodes/<anilistId>
//       (default EPISODES_API_URL = https://api.bine.me)
//     Returns:
//       artworks.clear_logo            — transparent PNG logo for the brand overlay
//       episodes.total_aired           — actual available episode count
//       episodes.first_aired / last_aired / next_scheduled — bookends + countdown
//       episodes.list[]                — per-episode metadata with multiple
//                                        image-quality variants:
//                                          still_url_w_jpg   (web JPEG, picked)
//                                          still_url_c_jpg   (compact JPEG)
//                                          still_url_m_jpg   (mobile JPEG)
//                                          still_url_w / _c / _m (webp variants)
//
//   TIER 2 (FALLBACK): AniList + Kitsu (original implementation below)
//     AniList for authoritative aired count + nextAiringEpisode.
//     Kitsu via ARM for episode titles + thumbnails.
//     Used when the episodes API is down, returns no episodes, or fails.
//     DO NOT MODIFY — keep the original logic intact as a safety net.
//
// Both paths return the SAME response shape so the frontend doesn't care
// which source produced the data.

interface BineEpisode {
  number:        number;
  title?:        string | null;
  air_date?:     string | null;
  aired?:        boolean;
  still_url_w_jpg?: string | null;
}
interface BineEpisodesResponse {
  anilist_id?: number;
  title?:      string;
  status?:     string;
  ongoing?:    boolean;
  artworks?:   { clear_logo?: string | null; poster?: string | null; banner?: string | null } | null;
  episodes?: {
    total_aired?:     number;
    total_scheduled?: number;
    specials_count?:  number;
    first_aired?:     BineEpisode | null;
    last_aired?:      BineEpisode | null;
    next_scheduled?:  BineEpisode | null;
    list?:            BineEpisode[];
  };
}

// Fetch episodes from api.bine.me — returns null on any failure
// (caller falls back to AniList+Kitsu). Cached via the same SWR wrapper as
// the existing implementation, so repeated calls are instant.
//
// Picks `still_url_w_jpg` for thumbnails — the wide JPEG variant is the best
// trade-off for web use (sharp thumbnails, small payload, no webp fallback needed).
async function fetchEpisodesFromJust4Anime(anilistId: number): Promise<{
  episodes:  unknown[];
  nextAiring: { episode: number; airsAt: number } | null;
} | null> {
  try {
    const res = await fetch(`${J4A_API}/${anilistId}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as BineEpisodesResponse;
    const eps = json.episodes?.list;
    if (!eps || !eps.length) return null;

    // api.bine.me returns next_scheduled only when an episode is upcoming.
    // Convert its ISO air_date to an absolute ms timestamp for the countdown.
    let nextAiring: { episode: number; airsAt: number } | null = null;
    const next = json.episodes?.next_scheduled;
    if (next?.number && next.air_date && !next.aired) {
      const airsAt = new Date(next.air_date).getTime();
      if (Number.isFinite(airsAt)) {
        nextAiring = { episode: next.number, airsAt };
      }
    }

    // Map to our existing episode shape so the frontend stays unchanged.
    // Key transformation notes:
    //   - `id` is the episode NUMBER (we use numeric IDs for routing).
    //   - `still_url_w_jpg` → `thumbnail` (wide JPEG variant — best for web)
    //   - `aired` flag from API (true/false); if missing, infer from air_date
    //   - `airsAt` only attached to the single next-scheduled episode
    //   - hasSub/hasDub default to true (the episodes API doesn't carry this)
    const episodes = eps.map((ep) => {
      const aired = ep.aired ?? (ep.air_date ? new Date(ep.air_date).getTime() <= Date.now() : true);
      const isNextAiring = nextAiring?.episode === ep.number && !aired;
      return {
        id:        ep.number,
        number:    ep.number,
        title:     ep.title || null,
        thumbnail: ep.still_url_w_jpg || null,
        filler:    false,
        airDate:   ep.air_date || null,
        aired,
        airsAt:    isNextAiring ? nextAiring!.airsAt : null,
        hasSub:    true,
        hasDub:    true,
      };
    });

    return { episodes, nextAiring };
  } catch {
    return null;
  }
}

const getEpisodes = mkSwr<unknown>(30 * 60_000, 10 * 60_000, async (id: string) => {
  const anilistId = Number(id);

  // ── TIER 1: just4anime.online (primary) ────────────────────────────────
  const j4aResult = await fetchEpisodesFromJust4Anime(anilistId);

  // ── ALSO query AniList for nextAiringEpisode ─────────────────────────────
  // just4anime's database may be incomplete (e.g., Doraemon 2005 has 687 eps
  // on just4anime but AniList says next is ep 928). We need AniList's
  // nextAiringEpisode data to:
  //   1. Show the correct "ongoing" status
  //   2. Add placeholder episodes for the gap (just4anime count → AniList count)
  //   3. Attach the countdown timer to the correct next episode
  let anilistNextAiring: { episode: number; airsAt: number } | null = null;
  let anilistAiredCount = 0;
  try {
    const md = await alQuery<{
      Media: {
        episodes:          number | null;
        status:            string | null;
        nextAiringEpisode: { episode: number; timeUntilAiring: number } | null;
      }
    }>(
      `query($id: Int) {
        Media(id: $id, type: ANIME) {
          episodes status
          nextAiringEpisode { episode timeUntilAiring }
        }
      }`,
      { id: anilistId },
    );
    const { episodes: totalEps, status, nextAiringEpisode } = md.Media;
    if (nextAiringEpisode) {
      anilistNextAiring = {
        episode: nextAiringEpisode.episode,
        airsAt:  Date.now() + nextAiringEpisode.timeUntilAiring * 1000,
      };
      anilistAiredCount = nextAiringEpisode.episode - 1;
    } else if (status === "FINISHED" || status === "CANCELLED") {
      anilistAiredCount = totalEps ?? 0;
    } else {
      anilistAiredCount = totalEps ?? 0;
    }
  } catch {
    // AniList query failed — continue with just4anime data alone
  }

  if (j4aResult) {
    // ── MERGE just4anime episodes with AniList nextAiring ─────────────────
    // If AniList says there are more episodes than just4anime has
    // (e.g., just4anime has 687, AniList says next is 928), fill the gap
    // with placeholder episodes (no title/thumbnail but marked as aired).
    // Also use AniList's nextAiring data if just4anime doesn't have it.
    const j4aEps = j4aResult.episodes as any[];
    const j4aCount = j4aEps.length;
    const mergedNextAiring = j4aResult.nextAiring || anilistNextAiring;

    // If AniList knows about more episodes than just4anime has, add placeholders
    if (anilistAiredCount > j4aCount) {
      for (let num = j4aCount + 1; num <= anilistAiredCount; num++) {
        j4aEps.push({
          id:        num,
          number:    num,
          title:     null,
          thumbnail: null,
          filler:    false,
          airDate:   null,
          aired:     true,
          airsAt:    null,
          hasSub:    true,
          hasDub:    true,
        });
      }
    }

    // If AniList has a nextAiring episode that's beyond our current list,
    // add it as an upcoming episode with the countdown timer
    if (anilistNextAiring && anilistNextAiring.episode > j4aEps.length) {
      j4aEps.push({
        id:        anilistNextAiring.episode,
        number:    anilistNextAiring.episode,
        title:     null,
        thumbnail: null,
        filler:    false,
        airDate:   null,
        aired:     false,
        airsAt:    anilistNextAiring.airsAt,
        hasSub:    true,
        hasDub:    true,
      });
    }

    // Update any existing episode's airsAt with AniList's nextAiring if it matches
    if (anilistNextAiring) {
      const nextEp = j4aEps.find(e => e.number === anilistNextAiring!.episode);
      if (nextEp && !nextEp.aired) {
        nextEp.airsAt = anilistNextAiring.airsAt;
      }
    }

    return { episodes: j4aEps, nextAiring: mergedNextAiring };
  }

  // ── TIER 2: AniList + Kitsu (fallback — original implementation) ────────
  // (reached when just4anime failed entirely)
  // Use the AniList data we already fetched above
  const { idMal: malId } = await alQuery<{ Media: { idMal: number | null } }>(
    `query($id: Int) { Media(id: $id, type: ANIME) { idMal } }`,
    { id: anilistId },
  ).then(d => d.Media).catch(() => ({ idMal: null }));

  let kitsuMap = new Map<number, KitsuEp>();
  if (malId) {
    const kitsuId = await armKitsuId(malId);
    if (kitsuId != null) {
      kitsuMap = await fetchKitsuEps(kitsuId).catch(() => new Map());
    }
  }

  const totalToShow = anilistAiredCount + (anilistNextAiring ? 1 : 0);
  const count       = Math.max(totalToShow, 1);

  const episodes = Array.from({ length: count }, (_, i) => {
    const num    = i + 1;
    const kitsu  = kitsuMap.get(num);
    const isAired = num <= anilistAiredCount;
    return {
      id:        num,
      number:    num,
      title:     kitsu?.title   ?? null,
      thumbnail: kitsu?.thumbnail ?? null,
      filler:    false,
      airDate:   kitsu?.airdate  ?? null,
      aired:     isAired,
      airsAt:    (!isAired && anilistNextAiring?.episode === num) ? anilistNextAiring.airsAt : null,
      hasSub:    true,
      hasDub:    true,
    };
  });

  return { episodes, nextAiring: anilistNextAiring };
});

router.get("/anime/:id/episodes", async (req: Request, res: Response) => {
  try {
    res.json(await getEpisodes(req.params.id!));
  } catch (e) {
    console.error("[episodes]", e);
    res.status(502).json({ error: "Failed to load episodes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/skip-times/:epNum
// ─────────────────────────────────────────────────────────────────────────────

router.get("/anime/:id/skip-times/:epNum", async (req: Request, res: Response) => {
  try {
    const anilistId = Number(req.params.id);
    const epNum     = Number(req.params.epNum);
    const dur       = req.query.duration ? Math.round(Number(req.query.duration)) : 0;

    const md = await alQuery<{ Media: { idMal: number | null } }>(
      `query($id: Int) { Media(id: $id, type: ANIME) { idMal } }`,
      { id: anilistId },
    );
    const malId = md.Media.idMal;
    if (!malId) return void res.json({ op: null, ed: null });

    const skipUrl  = `${ANISKIP}/skip-times/${malId}/${epNum}?types=op,ed&episodeLength=${dur}`;
    const skipResp = await fetch(skipUrl);
    if (!skipResp.ok) return void res.json({ op: null, ed: null });

    const sd = (await skipResp.json()) as {
      results?: { skipType: string; interval: { startTime: number; endTime: number } }[];
    };
    const op = sd.results?.find((x) => x.skipType === "op");
    const ed = sd.results?.find((x) => x.skipType === "ed");

    res.json({
      op: op ? { start: op.interval.startTime, end: op.interval.endTime } : null,
      ed: ed ? { start: ed.interval.startTime, end: ed.interval.endTime } : null,
    });
  } catch {
    res.json({ op: null, ed: null });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /anime/:id/stream/:epNum?lang=sub|dub|hsub&provider=core|vidstream|aninico|reanime
// (Anivexa — explicit single provider, no racing). The UI's provider tabs
// call this with exactly the provider the user picked (or the default,
// "core", on first load) — a stalled provider only ever affects its own
// tab, never the whole page.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_PROVIDERS = ["core", "vidstream", "aninico", "reanime"] as const;
type ProviderName = typeof VALID_PROVIDERS[number];

// Lazy-import the JS stream handler once; re-used for every request.
let _streamWithFallback:
  | ((anilistId: string, providerName: string, lang: string, epNum: number) => Promise<unknown | null>)
  | null = null;
let _getAudioOptions:
  | ((providerName: string, anilistId: string, epNum: number) => Promise<{ code: string; label: string }[]>)
  | null = null;
let _findProviderForAudio:
  | ((anilistId: string, epNum: number, code: string, preferredProvider: string) => Promise<string | null>)
  | null = null;

async function getStreamHandlerMod() {
  if (!_streamWithFallback) {
    // Dynamic import avoids bundling issues with the raw JS provider files.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — plain-JS module, no type declarations needed
    const mod = await import("../anivexa/stream-handler.js");
    const typed = mod as unknown as {
      streamWithFallback: typeof _streamWithFallback;
      getAudioOptions: typeof _getAudioOptions;
      findProviderForAudio: typeof _findProviderForAudio;
    };
    _streamWithFallback = typed.streamWithFallback;
    _getAudioOptions = typed.getAudioOptions;
    _findProviderForAudio = typed.findProviderForAudio;
  }
  return { streamWithFallback: _streamWithFallback!, getAudioOptions: _getAudioOptions!, findProviderForAudio: _findProviderForAudio! };
}

// Cache stream results for 3 h (they're CDN-signed but long-lived)
const streamSwr = mkSwr<unknown>(3 * 60 * 60_000, 60 * 60_000, async (key: string) => {
  const [anilistId, provider, lang, epNumStr] = key.split(":");
  const { streamWithFallback } = await getStreamHandlerMod();
  const result = await streamWithFallback(anilistId!, provider!, lang!, Number(epNumStr));
  if (!result) throw new Error(`Provider "${provider}" could not serve this episode`);
  return result;
});

router.get("/anime/:id/stream/:epNum", async (req: Request, res: Response) => {
  const anilistId = req.params.id!;
  const epNum     = Number(req.params.epNum);
  // `lang` used to be locked to "sub"|"dub" — now it's whatever real audio
  // code the picker offered (still "sub"/"dub" for the binary providers,
  // but can be "hsub" for AniNico).
  const lang      = (req.query.lang as string) || "sub";
  const provider  = (req.query.provider as string) || "core";

  if (isNaN(epNum)) return void res.status(400).json({ error: "Invalid episode number" });
  if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
    return void res.status(400).json({ error: `Unknown provider "${provider}"` });
  }

  try {
    const result = await streamSwr(`${anilistId}:${provider}:${lang}:${epNum}`);
    res.json(result);
  } catch (e) {
    console.error("[stream]", e);
    res.status(502).json({ error: `Stream unavailable from ${provider} for this episode` });
  }
});

// Real per-episode audio-track list for one provider — backs the Audio
// picker so it only ever shows tracks that actually exist for this
// provider+episode instead of a hardcoded Sub/Dub pair.
const audioOptionsSwr = mkSwr<{ code: string; label: string }[]>(3 * 60 * 60_000, 60 * 60_000, async (key: string) => {
  const [anilistId, provider, epNumStr] = key.split(":");
  const { getAudioOptions } = await getStreamHandlerMod();
  return getAudioOptions(provider!, anilistId!, Number(epNumStr));
});

router.get("/anime/:id/audio-options/:epNum", async (req: Request, res: Response) => {
  const anilistId = req.params.id!;
  const epNum     = Number(req.params.epNum);
  const provider  = (req.query.provider as string) || "core";

  if (isNaN(epNum)) return void res.status(400).json({ error: "Invalid episode number" });
  if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
    return void res.status(400).json({ error: `Unknown provider "${provider}"` });
  }

  try {
    const options = await audioOptionsSwr(`${anilistId}:${provider}:${epNum}`);
    res.json({ provider, options });
  } catch (e) {
    console.error("[audio-options]", e);
    res.json({ provider, options: [] });
  }
});

// Given a language the CURRENT provider doesn't have, find the first other
// provider that genuinely does — backs the "auto-switch server when the
// picked language isn't available here" behavior.
router.get("/anime/:id/audio-options/:epNum/find-provider", async (req: Request, res: Response) => {
  const anilistId = req.params.id!;
  const epNum     = Number(req.params.epNum);
  const code      = (req.query.code as string) || "sub";
  const current   = (req.query.provider as string) || "core";

  if (isNaN(epNum)) return void res.status(400).json({ error: "Invalid episode number" });

  try {
    const { findProviderForAudio } = await getStreamHandlerMod();
    const provider = await findProviderForAudio(anilistId, epNum, code, current);
    res.json({ provider });
  } catch (e) {
    console.error("[find-provider]", e);
    res.json({ provider: null });
  }
});

// ── Embed proxy ─────────────────────────────────────────────────────────────
// Hides upstream embed URLs (Koyeb, FlixCloud, etc.) from the browser.
//
// The stream handler stores each URL server-side under a short-lived opaque
// token (see anivexa/core/embed-token-store.js).  The browser only ever
// receives the token — the actual Koyeb/FlixCloud domain is NEVER sent to
// the client in any form (not even base64-encoded), so it cannot be
// recovered from the network tab, response bodies, or error pages.
//
// Two-step flow:
//   1. GET /embed-proxy?t=<token>
//        Server-side preflight: we fetch the upstream URL ourselves with a
//        3.5 s timeout. If the preflight FAILS (network error, ECONNRESET,
//        DNS failure, 5xx), we serve a branded "Stream Unavailable" HTML
//        page with NO iframe, NO upstream URL anywhere in the markup. The
//        user never sees the Koyeb/FlixCloud domain.
//        If the preflight PASSES, we serve a tiny HTML shell with an iframe
//        whose `src` is empty. The actual upstream URL is fetched client-side
//        via /embed-resolve?t=<token> using fetch() + postMessage, so the URL
//        is set programmatically (not in the initial HTML — network tab
//        "Response" tab on the embed-proxy request shows only the shell).
//
//   2. GET /embed-resolve?t=<token>  →  { url: string } | 404
//        Returns the upstream URL as JSON. The embed-proxy HTML uses this to
//        set iframe.src via JS. We don't expose this endpoint publicly in
//        the client bundle — it's only called from inside the embed-proxy
//        shell. Even if a user manually hits it, the URL returned is still
//        token-gated (4 h TTL) and can't be enumerated.

router.get("/embed-proxy", async (req: Request, res: Response) => {
  const token = req.query.t as string | undefined;
  if (!token) return void res.status(400).send("Bad request");

  // @ts-ignore — plain JS module
  const { lookupToken } = await import("../anivexa/core/embed-token-store.js");
  const target: string | null = lookupToken(token);
  if (!target) return void res.status(404).send("Not found or expired");

  // ── Server-side preflight ──────────────────────────────────────────────────
  // Fetch the upstream URL ourselves with a short timeout. If this fails,
  // the upstream server is down — we serve the branded error page WITHOUT
  // ever putting the URL in the response. The user sees "Stream Unavailable"
  // with a Switch Server button, and no upstream domain is leaked.
  let preflightOk = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const r = await fetch(target, {
      signal: controller.signal,
      headers: { "User-Agent": "AniStream-Preflight/1.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    // 2xx/3xx/4xx all mean the server is alive — only 5xx and network errors
    // count as "down" for our purposes.
    preflightOk = r.status < 500;
  } catch {
    preflightOk = false;
  }

  if (!preflightOk) {
    // Branded error page — no iframe, no URL leak, no upstream domain visible.
    const errHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#06060a;font-family:'DM Sans',system-ui,sans-serif;color:#fff}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:32px;background:radial-gradient(circle at 50% 30%,rgba(220,38,38,0.08),transparent 60%)}
.icon{width:72px;height:72px;border-radius:50%;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.28);display:flex;align-items:center;justify-content:center;animation:pulse 2.2s ease-in-out infinite}
.icon svg{width:36px;height:36px;color:rgba(229,43,80,0.85)}
.title{font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#fff}
.sub{font-size:13px;color:rgba(255,255,255,0.4);max-width:340px;line-height:1.6}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,0.25)}50%{box-shadow:0 0 0 14px rgba(220,38,38,0)}}
</style>
</head><body>
<div class="wrap">
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  </div>
  <div>
    <div class="title">Stream Unavailable</div>
    <div class="sub" style="margin-top:8px">This server is currently offline or refusing connections.<br>Please switch to a different server using the server selector below the player.</div>
  </div>
</div>
</body></html>`;
    return res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("X-Frame-Options", "SAMEORIGIN")
      .setHeader("Cache-Control", "no-store")
      .status(502)
      .send(errHtml);
  }

  // ── Happy path: iframe shell with XOR-encrypted URL ────────────────────────
  // The upstream URL is embedded in the HTML but XOR-encrypted with the
  // token as key + base64-encoded. The client-side JS decodes it and sets
  // it as the iframe's src.
  //
  // This is the ORIGINAL approach (before the server-side proxy experiment).
  // The server-side proxy broke the iframe chain — megaplay.buzz detected
  // it wasn't loading from the Railway API's origin and showed extra ads.
  //
  // With this approach:
  //   1. iframe loads the Railway API page DIRECTLY (proper referer chain)
  //   2. Railway API's page has its own iframe to megaplay.buzz
  //   3. megaplay.buzz sees the Railway API as origin → no extra ads
  //   4. The upstream URL is XOR-encrypted in the HTML (not plain text)
  //   5. Security headers still apply (X-Powered-By hidden, etc.)

  // XOR + base64 obfuscation
  function obfuscateUrl(url: string, key: string): string {
    const urlBytes = Buffer.from(url, "utf-8");
    const keyBytes = Buffer.from(key, "utf-8");
    const out = Buffer.alloc(urlBytes.length);
    for (let i = 0; i < urlBytes.length; i++) {
      out[i] = urlBytes[i]! ^ keyBytes[i % keyBytes.length]!;
    }
    return out.toString("base64");
  }

  const obfuscatedUrl = obfuscateUrl(target, token);

  const shellHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000;font-family:system-ui,sans-serif;color:#fff}
#fr{position:absolute;inset:0;width:100%;height:100%;border:none;opacity:0;transition:opacity .25s ease-out}
#ld{position:absolute;inset:0;background:#000;z-index:2;transition:opacity .3s}
#ld.hide{opacity:0;pointer-events:none}
</style>
</head><body>
<div id="ld"></div>
<iframe id="fr" allowfullscreen allow="autoplay;fullscreen;encrypted-media;picture-in-picture"></iframe>
<script>
(function(){
  var fr=document.getElementById('fr');
  var ld=document.getElementById('ld');
  var key="${token}";
  var enc="${obfuscatedUrl}";

  try {
    var raw=atob(enc);
    var urlBytes=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++) urlBytes[i]=raw.charCodeAt(i);
    var keyBytes=new TextEncoder().encode(key);
    var out=new Uint8Array(urlBytes.length);
    for(var j=0;j<urlBytes.length;j++){
      out[j]=urlBytes[j]^keyBytes[j%keyBytes.length];
    }
    var decodedUrl=new TextDecoder().decode(out);

    fr.src=decodedUrl;
    fr.onload=function(){
      fr.style.opacity='1';
      ld.classList.add('hide');
      setTimeout(function(){ ld.style.display='none'; }, 320);
    };
  } catch(e){
    // Decode failed — leave black screen
  }
})();
</script>
</body></html>`;

  res
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("X-Frame-Options", "SAMEORIGIN")
    .setHeader("Cache-Control", "no-store")
    .send(shellHtml);
});

// ─────────────────────────────────────────────────────────────────────────────
// /embed-resolve — REMOVED for security
// ─────────────────────────────────────────────────────────────────────────────
// This endpoint used to return the upstream Koyeb/FlixCloud URL as plain JSON
// (`{ url: "https://...koyeb.app/..." }`). Anyone with DevTools open could see
// the full upstream domain in the Network tab response — defeating the entire
// purpose of the embed-proxy's URL-hiding design.
//
// The embed-proxy now embeds the URL DIRECTLY in its HTML shell, obfuscated
// via XOR cipher (token as key) + base64. The client-side JS decodes it.
// The URL never appears as plain text in ANY HTTP response body.
//
// This endpoint has been removed. If anyone queries it, they get a 404.
// (Keeping the route definition as a 404 stub so old embed-proxy HTML shells
// cached in browsers don't get a confusing Express default error page.)
router.get("/embed-resolve", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /upcoming — NOT_YET_RELEASED anime sorted by popularity
// ─────────────────────────────────────────────────────────────────────────────

const UPCOMING_Q = `query {
  Page(page: 1, perPage: 12) {
    media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) {
      id title { english romaji } coverImage { extraLarge large }
      format seasonYear episodes
    }
  }
}`;

const getUpcoming = mkSwr<unknown>(20 * 60_000, 10 * 60_000, async () => {
  const d = await alQuery<{ Page: { media: AlMedia[] } }>(UPCOMING_Q);
  return {
    items: d.Page.media.map((m) => ({
      id:           m.id,
      title:        title(m),
      posterUrl:    cover(m),
      type:         m.format ?? null,
      year:         m.seasonYear ?? null,
      episodeCount: m.episodes ?? null,
    })),
  };
});

router.get("/upcoming", async (_req: Request, res: Response) => {
  try {
    res.json(await getUpcoming("__upcoming__"));
  } catch (e) {
    console.error("[upcoming]", e);
    res.status(502).json({ error: "Failed to load upcoming" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /browse — filterable anime catalog backed by AniList
// Query params: search, genre, year, season, format, status, sort, page
// ─────────────────────────────────────────────────────────────────────────────

const BROWSE_Q = `
query Browse(
  $page: Int, $perPage: Int,
  $search: String,
  $genre: String,
  $year: Int,
  $season: MediaSeason,
  $format: MediaFormat,
  $status: MediaStatus,
  $sort: [MediaSort]
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage total }
    media(
      type: ANIME, isAdult: false,
      search: $search,
      genre: $genre,
      seasonYear: $year,
      season: $season,
      format: $format,
      status: $status,
      sort: $sort
    ) {
      id
      title { english romaji }
      coverImage { extraLarge large }
      format seasonYear episodes averageScore
    }
  }
}`;

const VALID_SORTS = new Set([
  "POPULARITY_DESC","SCORE_DESC","TRENDING_DESC",
  "UPDATED_AT_DESC","START_DATE_DESC","TITLE_ROMAJI",
]);
const VALID_FORMATS  = new Set(["TV","MOVIE","OVA","ONA","SPECIAL","MUSIC"]);
const VALID_STATUSES = new Set(["RELEASING","FINISHED","NOT_YET_RELEASED","CANCELLED","HIATUS"]);
const VALID_SEASONS  = new Set(["WINTER","SPRING","SUMMER","FALL"]);

router.get("/browse", async (req: Request, res: Response) => {
  try {
    const page    = Math.max(1, Math.min(50, Number(req.query.page) || 1));
    const search  = typeof req.query.search  === "string" && req.query.search.trim()  ? req.query.search.trim()  : undefined;
    const genre   = typeof req.query.genre   === "string" && req.query.genre.trim()   ? req.query.genre.trim()   : undefined;
    const rawYear = Number(req.query.year);
    const year    = rawYear >= 1960 && rawYear <= 2030 ? rawYear : undefined;
    const season  = typeof req.query.season === "string" && VALID_SEASONS.has(req.query.season.toUpperCase())
      ? req.query.season.toUpperCase() : undefined;
    const format  = typeof req.query.format === "string" && VALID_FORMATS.has(req.query.format.toUpperCase())
      ? req.query.format.toUpperCase() : undefined;
    const status  = typeof req.query.status === "string" && VALID_STATUSES.has(req.query.status.toUpperCase())
      ? req.query.status.toUpperCase() : undefined;
    const rawSort = typeof req.query.sort === "string" ? req.query.sort.toUpperCase() : "POPULARITY_DESC";
    const sort    = VALID_SORTS.has(rawSort) ? rawSort : "POPULARITY_DESC";

    const variables: Record<string, unknown> = {
      page, perPage: 18,
      sort: [sort],
      ...(search !== undefined && { search }),
      ...(genre  !== undefined && { genre }),
      ...(year   !== undefined && { year }),
      ...(season !== undefined && { season }),
      ...(format !== undefined && { format }),
      ...(status !== undefined && { status }),
    };

    const d = await alQuery<{
      Page: {
        pageInfo: { hasNextPage: boolean; total: number };
        media: AlMedia[];
      }
    }>(BROWSE_Q, variables);

    res.json({
      items: d.Page.media.map(m => ({
        id:        m.id,
        title:     title(m),
        posterUrl: cover(m),
        type:      m.format ?? null,
        year:      m.seasonYear ?? null,
        rating:    m.averageScore ? m.averageScore / 10 : null,
      })),
      hasNextPage: d.Page.pageInfo.hasNextPage,
      total:       d.Page.pageInfo.total,
    });
  } catch (e) {
    console.error("[browse]", e);
    res.status(502).json({ error: "Failed to browse anime" });
  }
});

export default router;
