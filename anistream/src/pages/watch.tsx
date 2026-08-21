import { useParams, Link, useLocation } from "wouter";
import { customFetch, withClientHeader } from "../lib/custom-fetch";
import { apiUrl } from "../lib/api";
import { saveToContinueWatching } from "../lib/continue-watching";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  useState, useEffect, useRef, useMemo, useCallback, forwardRef,
  type ComponentRef,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import Hls from "hls.js";
import {
  MediaPlayer, MediaProvider, Track, isHLSProvider,
  useMediaState, useMediaRemote,
  type MediaPlayerInstance, type MediaProviderAdapter,
} from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/base.css";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import {
  Play, AlertCircle, ChevronLeft, Layers,
  Headphones, SkipForward, SkipBack, Tv2,
  ChevronDown, X, ChevronsRight, Globe, Menu, Lock, Star, Clock, Clock3,
} from "lucide-react";
import { cn } from "../lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface EpisodeStreamResult {
  streamUrl:   string;
  isEmbed?:    boolean;
  artworkUrl?: string | null;
  provider?:   string;
  providerLabel?: string;
  isHardSub?:  boolean;
  subtitles?:  Array<{ url: string; label: string; srclang: string; format?: string }>;
  currentLang?: string;
  // The provider tab the caller actually asked for, and whether the backend
  // had to fall back to a different one because the requested provider
  // doesn't have this audio track for this episode (e.g. AniDB has no
  // English dub) — used to move the active tab to match reality instead of
  // silently playing from a provider the user didn't pick.
  requestedProvider?: string;
  switchedProvider?: boolean;
  // True when the requested provider was fine but didn't have the
  // requested audio track for this episode, so the SAME provider served
  // whatever track it does have instead (see `currentLang` for which one)
  // — distinct from `switchedProvider`, which means a different server
  // had to be used because the requested one was down/broken.
  audioFallback?: boolean;
}

interface AudioOption { code: string; label: string }

// Hardcoded provider list. Each tab is fetched only when the user actually
// selects it (or on first load for the default), never all at once.
// Server → API provider mapping (per the new /pop endpoint spec):
//   core      → "default"  (Megaplay embed, sub + dub)
//   vidstream → "vs"        (Megaplay VidStream player, sub + dub)
//   aninico   → "am"        (Megaplay AniNico player, sub + dub + hsub)
//   reanime   → "re"        (direct flixcloud.cc iframe, sub + dub)
// ★ marks the recommended default server. Only AniNico carries hsub.
const PROVIDER_TABS = [
  { id: "core",      label: "Core",      recommended: true  },
  { id: "vidstream", label: "VidStream", recommended: false },
  { id: "aninico",   label: "AniNico",   recommended: false },
  { id: "reanime",   label: "ReAnime",   recommended: false },
] as const;
type ProviderId = typeof PROVIDER_TABS[number]["id"];
// Core is the recommended default — Megaplay embed with sub + dub.
const DEFAULT_PROVIDER: ProviderId = "core";

interface Episode {
  id:        number;
  number:    number;
  number2?:  number | null;
  title?:    string | null;
  thumbnail?: string | null;  // Kitsu episode thumbnail (16:9)
  filler?:   boolean;
  hasSub?:   boolean;
  hasDub?:   boolean;
  airDate?:  string | null;
  aired?:    boolean;         // explicit flag from backend (AniList authoritative)
  airsAt?:   number | null;   // ms timestamp for the immediate next episode
}

// Returns true if an episode has aired.
// Uses the explicit `aired` flag from the backend when available (AniList-authoritative).
// Falls back to airDate comparison for backwards-compat with cached data.
function isEpisodeAired(ep: Episode): boolean {
  if (ep.aired !== undefined) return ep.aired;
  if (!ep.airDate) return true; // no air date info → assume aired
  return new Date(ep.airDate).getTime() <= Date.now();
}

// Format milliseconds remaining into live ticking clock format.
// Always shows seconds — ticks down every second like a real clock.
function formatCountdown(ms: number): string {
  if (ms <= 0) return "Airing now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

interface Season {
  id:        number;
  title:     string;
  isCurrent: boolean;
  posterUrl?: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Returns a HONEST label for the given audio code.
// If we have a confirmed option list and the code is in it, use that label.
// If the code is NOT in the confirmed list, return a neutral "Loading…" style
// label instead of GUESSING "English Dub" (which was wrong for providers that
// only have Japanese sub but were being shown as "English" in the button).
//
// Special-cases:
//   - code === "sub" → "Japanese" (always Japanese audio with subtitles, by
//     convention across all providers — this is always safe to claim)
//   - code === "dub" → ONLY return "English Dub" if dub is actually in the
//     confirmed options list. Otherwise return "Dub" (neutral).
//   - isHardSub === true → append " (H-Sub)" to the label
function getAudioLabel(code: string, options: AudioOption[], isHardSub?: boolean): string {
  // Confirmed label from the backend's audio-options probe
  const opt = options.find((o) => o.code === code);
  if (opt) {
    return code === "sub" && isHardSub ? `${opt.label} (H-Sub)` : opt.label;
  }

  // Fallbacks — only claim things we're SURE about
  if (code === "sub") {
    // "sub" is by convention Japanese audio + subtitles — universally true
    return isHardSub ? "Japanese (H-Sub)" : "Japanese";
  }
  if (code === "dub") {
    // Don't claim "English" unless the backend confirmed it — could be any
    // language dub. Use neutral "Dub" until the probe resolves.
    return "Dub";
  }
  // Unknown code — just show it capitalized, no language guess
  return code.charAt(0).toUpperCase() + code.slice(1);
}

// ── Stream progress bar ────────────────────────────────────────────────────
// A thin bar across the top of the player that animates while the API is
// fetching the stream URL, then snaps to 100% and fades out on completion.
// Gives instant visual feedback that something is happening after episode
// selection even before the API responds.
function StreamProgressBar({ isLoading }: { isLoading: boolean }) {
  type Phase = "idle" | "loading" | "completing";
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    if (isLoading) {
      setPhase("loading");
      return undefined;
    }
    if (phase === "loading") {
      // Snap to 100%, then fade out.
      setPhase("completing");
      const t = setTimeout(() => setPhase("idle"), 650);
      return () => clearTimeout(t);
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (phase === "idle") return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-30 h-[3px] overflow-hidden">
      {/* dim track */}
      <div className="absolute inset-0 bg-white/5" />
      <motion.div
        className="h-full bg-primary"
        style={{ boxShadow: "0 0 12px 2px rgba(220,38,38,0.65)" }}
        initial={{ width: "0%", opacity: 1 }}
        animate={
          phase === "loading"
            ? { width: "82%", opacity: 1 }
            : { width: "100%", opacity: 0 }
        }
        transition={
          phase === "loading"
            ? { width: { duration: 9, ease: [0.05, 0.25, 0.55, 0.92] }, opacity: { duration: 0 } }
            : { width: { duration: 0.22, ease: "easeOut" }, opacity: { duration: 0.35, delay: 0.2 } }
        }
      />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export function Watch() {
  const { animeId, episodeId: episodeIdParam } = useParams<{ animeId: string; episodeId?: string }>();
  const id = Number(animeId);
  const [, setLocation] = useLocation();

  // Read lang and provider from URL query params (set by Continue Watching links).
  // This allows the user to resume in the same audio language + provider they
  // were using when they last watched the anime.
  // wouter doesn't have a built-in searchParams hook, so we parse it manually.
  const searchParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null;
  const urlLang = searchParams?.get('lang');
  const urlProvider = searchParams?.get('provider');

  // Episode selection: initialize ONCE from URL param — never reset by effects
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<number | null>(
    episodeIdParam ? Number(episodeIdParam) : null
  );
  // Default straight to Japanese/sub — no upfront "choose audio" step.
  // But if the URL has a lang param (from Continue Watching), use that instead.
  const [selectedLang, setSelectedLang] = useState<string>(urlLang || "sub");
  // Which provider tab is active. Persists across episode/lang changes —
  // switching episodes keeps using the same provider, exactly like the user
  // asked, instead of silently resetting to the default every time.
  // If URL has a provider param (from Continue Watching), use that.
  const [activeProvider, setActiveProvider] = useState<ProviderId>(
    (urlProvider as ProviderId) || DEFAULT_PROVIDER
  );

  // ── Stream prefetch on episode hover ─────────────────────────────────────
  // When the user hovers an episode card for >100 ms, prefetch its stream URL
  // so the cache is warm before they click — zero-latency playback on click.
  const queryClient = useQueryClient();
  const prefetchEpisodeStream = useCallback(
    (epId: number) => {
      queryClient.prefetchQuery({
        queryKey: ["/api/stream", id, epId, activeProvider, selectedLang],
        queryFn: () =>
          fetch(
            apiUrl(`/api/anime/${id}/stream/${epId}?lang=${selectedLang}&provider=${activeProvider}`),
            { headers: withClientHeader() }
          ).then((r) => r.json()),
        staleTime: 5 * 60 * 1000,
      });
    },
    [queryClient, id, activeProvider, selectedLang]
  );

  // ── Data fetching ────────────────────────────────────────────────────────

  const { data: animeDetails } = useQuery({
    queryKey: ["anime-details", id],
    queryFn: () => fetch(apiUrl(`/api/anime/${id}/details`), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  // TVDB stylized logo URL — fetched once per anime, cached permanently.
  // Used as the branded loading overlay while the stream URL resolves.
  // Returns { logoUrl: string | null }. When null (no logo found on TVDB),
  // the watch page falls back to its default black-screen loading state.
  const { data: logoData } = useQuery<{ logoUrl: string | null }>({
    queryKey: ["anime-logo", id],
    queryFn: () => fetch(apiUrl(`/api/anime/${id}/logo`), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: Infinity,        // TVDB slugs never change — cache forever
    retry: false,               // Don't retry on failure — fall back silently
  });
  const logoUrl = logoData?.logoUrl ?? null;

  const { data: seasonsData } = useQuery<{ seasons: Season[] }>({
    queryKey: ["anime-seasons", id],
    queryFn: () => fetch(apiUrl(`/api/anime/${id}/seasons`), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: 15 * 60 * 1000,
  });

  const { data: episodesData, isLoading: episodesLoading, isError: episodesError } =
    useQuery<{ episodes: Episode[]; nextAiring: { episode: number; airsAt: number } | null }>({
      queryKey: ["anime-episodes", id],
      queryFn: () => fetch(apiUrl(`/api/anime/${id}/episodes`), { headers: withClientHeader() }).then(r => r.json()),
      enabled: !!id,
      staleTime: 30 * 60 * 1000,
    });

  const episodes = (episodesData?.episodes ?? []) as Episode[];

  // Live clock — updates every second for countdown timers on upcoming episodes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seasons = seasonsData?.seasons ?? [];

  // Only episodes that have aired (or have no air-date info) can be watched.
  // This is the single source of truth — all selection paths (list click,
  // prev/next, URL param, auto-select, prefetch) go through this check.
  const airedEpisodes = useMemo(() => episodes.filter(isEpisodeAired), [episodes]);

  // Auto-select first AIRED episode only once, when nothing is in URL.
  // If the URL carries an episode ID that hasn't aired yet, redirect to
  // the first aired episode instead so the stream query is never triggered
  // for unreleased content.
  const initialSelectDone = useRef(false);
  useEffect(() => {
    if (airedEpisodes.length === 0) return;
    if (!initialSelectDone.current) {
      initialSelectDone.current = true;
      if (!selectedEpisodeId) {
        // No URL param — pick first aired episode.
        userClickedEpRef.current = 2;
        const firstId = airedEpisodes[0]!.id;
        setSelectedEpisodeId(firstId);
        setLocation(`/watch/${id}/${firstId}`, { replace: true });
      } else {
        // URL param present — verify it's actually aired.
        const epFromUrl = episodes.find((e) => e.id === selectedEpisodeId);
        if (epFromUrl && !isEpisodeAired(epFromUrl)) {
          // Episode hasn't aired yet — fall back to first aired one.
          const firstId = airedEpisodes[0]!.id;
          setSelectedEpisodeId(firstId);
          setLocation(`/watch/${id}/${firstId}`, { replace: true });
        }
      }
    }
  }, [airedEpisodes, episodes, selectedEpisodeId, id, setLocation]);

  // Only the currently-active provider tab is ever fetched — switching tabs
  // fires exactly one new request for that provider; the other two are never
  // called until the user actually clicks them.
  // Deliberately NOT using `placeholderData: keepPreviousData` here — with
  // it, switching episodes/providers/language kept the OLD video silently
  // playing (status stayed "success" the whole time) until the new stream
  // resolved or failed, which is exactly why clicking an episode looked
  // like nothing happened. Without it, the query key change immediately
  // flips to pending/loading so the spinner shows the moment you click.
  const { data: stream, isLoading: streamLoading, isFetching: streamFetching, isError: streamError } = useQuery<EpisodeStreamResult>({
    queryKey: ["/api/stream", id, selectedEpisodeId, activeProvider, selectedLang],
    // Only fetch when the episode exists AND has actually aired — never fire
    // a stream request for unreleased content even if selectedEpisodeId is set.
    enabled: !!selectedEpisodeId && airedEpisodes.some((e) => e.id === selectedEpisodeId),
    staleTime: 8 * 60 * 1000,
    queryFn: ({ signal }) => {
      return customFetch<EpisodeStreamResult>(
        apiUrl(`/api/anime/${id}/stream/${selectedEpisodeId}?lang=${selectedLang}&provider=${activeProvider}`),
        { signal },
      );
    },
  });

  // Real per-episode audio-track list — fetched for ALL providers eagerly so
  // the server modal and audio modal both show accurate, real data from the
  // moment they open. Server-side results are cached (3 h SWR + in-process
  // probe cache) so firing all 5 at once costs ≤15 Koyeb probes for the
  // very first user on a given episode; everyone else hits the cache.
  const audioOptionQueries = useQueries({
    queries: PROVIDER_TABS.map((tab) => ({
      queryKey: ["audio-options", id, selectedEpisodeId, tab.id],
      // Active provider probes immediately so the audio label is ready.
      // All other providers wait until the stream is loaded — they only
      // feed the audio/server modals, which the user opens after playback starts.
      // Fetch audio options only AFTER the stream URL is ready — this avoids
      // sending 3 Koyeb probe requests (sub/dub/hsub) in parallel with the
      // initial stream fetch, which was adding 5-10 s of latency on cold loads.
      // The stream (Japanese/sub) launches instantly; the audio picker
      // populates a moment later once the first stream is already playing.
      enabled: !!selectedEpisodeId && !!stream?.streamUrl,
      staleTime: 8 * 60 * 1000,
      queryFn: () =>
        customFetch<{ provider: string; options: AudioOption[] }>(
          apiUrl(`/api/anime/${id}/audio-options/${selectedEpisodeId}?provider=${tab.id}`),
        ),
    })),
  });
  // Cheap (4 providers max) — recomputed plainly every render instead of
  // useMemo, since useQueries returns a fresh array each render anyway and
  // a memo key here would need to serialize every provider's options list.
  const audioOptionsByProvider: Record<string, AudioOption[]> = {};
  PROVIDER_TABS.forEach((tab, i) => {
    audioOptionsByProvider[tab.id] = audioOptionQueries[i]?.data?.options ?? [];
  });
  const currentAudioOptions = audioOptionsByProvider[activeProvider] ?? [];
  // True while the active provider's probe hasn't settled yet — used to
  // suppress "not on this server" labels that would be incorrect while loading.
  const activeProviderIdx     = PROVIDER_TABS.findIndex(t => t.id === activeProvider);
  const currentProviderLoading = !(audioOptionQueries[activeProviderIdx]?.isFetched ?? false);
  // Union across all providers, first-seen label wins — what the Audio
  // modal actually lists, so picking a track absent from the current
  // provider is possible in the first place.
  const mergedAudioOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tab of PROVIDER_TABS) {
      for (const opt of audioOptionsByProvider[tab.id] ?? []) {
        if (!seen.has(opt.code)) seen.set(opt.code, opt.label);
      }
    }
    // Deduplicate: ensure only one entry per code (no duplicate "English" etc.)
    return [...seen.entries()].map(([code, label]) => ({ code, label }));
  }, [audioOptionsByProvider]);

  // Picking a track just sets the desired language and stays on whatever
  // provider tab is currently active — it deliberately does NOT jump to a
  // different server anymore. If the active provider doesn't actually have
  // that track for this episode, the backend serves whatever it does have
  // on the SAME provider (see `stream.audioFallback` below) instead of
  // teleporting the user to a different server they didn't ask for.
  function selectAudio(code: string) {
    setShowAudioModal(false);
    setSelectedLang(code);
  }

  // Two distinct notices, matching two distinct backend behaviors:
  //  - `audioFallback`: the active provider is fine, it just doesn't have
  //    the requested track for this episode — same provider, different
  //    audio actually played. Correct `selectedLang` to match reality so
  //    the audio button/label don't lie about what's playing.
  //  - `switchedProvider`: the requested provider couldn't produce a
  //    stream at all — backend served from a fallback. We do NOT auto-switch
  //    the active tab; we show a dismissable "switch?" prompt instead so the
  //    user stays in control of which server they're on.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  // Provider suggested by the backend fallback — user clicks to accept it.
  const [suggestedProvider, setSuggestedProvider] = useState<{ id: ProviderId; label: string } | null>(null);

  useEffect(() => {
    if (!stream) return;
    // Audio-track not on this server — correct selectedLang to match what's
    // actually playing so the audio button label never lies. Also show a
    // brief notice so the user knows why the track changed.
    if (stream.audioFallback && stream.currentLang && stream.currentLang !== selectedLang) {
      setSelectedLang(stream.currentLang);
      setSwitchNotice("This audio track isn't available on this server. Please try another server.");
      setSuggestedProvider(null);
      return;
    }
    // Clear any stale notice when loading a fresh stream that worked fine.
    if (!stream.switchedProvider && !stream.audioFallback) {
      setSwitchNotice(null);
      setSuggestedProvider(null);
    }
  }, [stream?.audioFallback, stream?.switchedProvider, stream?.provider, stream?.currentLang, stream?.requestedProvider, stream?.providerLabel]);
  useEffect(() => {
    if (!switchNotice) return;
    const t = setTimeout(() => { setSwitchNotice(null); setSuggestedProvider(null); }, 8000);
    return () => clearTimeout(t);
  }, [switchNotice]);

  // Track providers that failed (stream error) so they can be flagged in the
  // server modal. Reset when the episode changes.
  useEffect(() => {
    if ((streamError || (!streamLoading && !stream?.streamUrl)) && activeProvider) {
      setFailedProviders((prev) => new Set([...prev, activeProvider]));
    }
  }, [streamError, stream?.streamUrl, streamLoading, activeProvider]);

  useEffect(() => {
    // Reset failed-provider tracking on episode change so stale errors
    // from a previous episode don't persist.
    setFailedProviders(new Set());
  }, [selectedEpisodeId]);

  // Prefetch the next AIRED episode's stream on the same provider/lang once
  // the current one has loaded, so hitting "next" feels instant.
  // Unaired episodes are never prefetched — they have no stream yet.
  useEffect(() => {
    if (!stream?.streamUrl) return;
    const currentIdx2 = airedEpisodes.findIndex((e) => e.id === selectedEpisodeId);
    const next = currentIdx2 >= 0 ? airedEpisodes[currentIdx2 + 1] : null;
    if (!next) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      customFetch<EpisodeStreamResult>(
        apiUrl(`/api/anime/${id}/stream/${next.id}?lang=${selectedLang}&provider=${activeProvider}`),
        { signal: controller.signal },
      ).catch(() => {});
    }, 1500); // slight delay so it never competes with the current episode's own request
    return () => { clearTimeout(timer); controller.abort(); };
  }, [stream?.streamUrl, selectedEpisodeId, activeProvider, selectedLang, episodes, id]);

  // ── Save to Continue Watching (localStorage) ──────────────────────────────
  // When the stream URL is ready, save this episode to the user's local
  // continue watching history. All data stays in the browser — no server
  // storage, no account needed. The homepage reads this and shows a
  // "Continue Watching" row.
  useEffect(() => {
    if (!stream?.streamUrl || !selectedEpisodeId) return;
    const ep = episodes.find((e) => e.id === selectedEpisodeId);
    if (!ep) return;
    saveToContinueWatching(
      {
        animeId:       id,
        episodeId:     selectedEpisodeId,
        episodeNumber: ep.number,
        title:         animeDetails?.title || "",
        posterUrl:     animeDetails?.posterUrl || animeDetails?.bannerUrl || "",
      },
      selectedLang,     // pass the user's selected audio language
      activeProvider,   // pass the user's selected provider
    );
  }, [stream?.streamUrl, selectedEpisodeId, id, episodes, animeDetails?.title, animeDetails?.posterUrl, animeDetails?.bannerUrl, selectedLang, activeProvider]);

  // ── Episode navigation ───────────────────────────────────────────────────

  const currentEp = episodes.find((e) => e.id === selectedEpisodeId);

  // When the selected episode changes, auto-correct selectedLang if the new
  // episode explicitly lacks the currently-selected audio track.
  // hasSub/hasDub can be undefined (= unknown) — only switch when explicitly false.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentEp) return;
    if (selectedLang === "dub" && currentEp.hasDub === false && currentEp.hasSub !== false) {
      setSelectedLang("sub");
    } else if (selectedLang === "sub" && currentEp.hasSub === false && currentEp.hasDub !== false) {
      setSelectedLang("dub");
    }
    // hsub is aninico-specific — no episode-level flag for it, leave it as-is
  }, [currentEp?.id]);

  // Prev/Next navigate within the AIRED subset only — unaired episodes are
  // skipped so the buttons can never land on an unreleased entry.
  const currentAiredIdx = airedEpisodes.findIndex((e) => e.id === selectedEpisodeId);
  const prevEp = currentAiredIdx > 0 ? airedEpisodes[currentAiredIdx - 1] : null;
  const nextEp = currentAiredIdx >= 0 && currentAiredIdx < airedEpisodes.length - 1
    ? airedEpisodes[currentAiredIdx + 1]
    : null;

  function selectEpisode(epId: number) {
    // Central guard — silently ignore any attempt to navigate to an episode
    // that hasn't aired yet, regardless of how the call was triggered
    // (list click, URL param resolution, keyboard shortcut, etc.).
    const ep = episodes.find((e) => e.id === epId);
    if (ep && !isEpisodeAired(ep)) return;

    userClickedEpRef.current = 2;
    setSelectedEpisodeId(epId);
    // Deliberately do NOT reset selectedLang or activeProvider here — the
    // same audio track and provider tab should carry over to the new
    // episode instead of forcing the user to re-pick every time.
    setLocation(`/watch/${id}/${epId}`, { replace: true });
  }

  // ── Batch selector (large series) ────────────────────────────────────────
  const BATCH_SIZE = 100;
  const batches = useMemo(() => {
    if (!episodes.length) return [];
    const res = [];
    for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
      res.push(episodes.slice(i, i + BATCH_SIZE));
    }
    return res;
  }, [episodes]);

  const [activeBatchIdx, setActiveBatchIdx] = useState(0);

  // When an episode changes (prev/next, autoplay), sync batch to it.
  // CRITICAL: activeBatchIdx must NOT be in deps — that caused the reset bug.
  useEffect(() => {
    if (!selectedEpisodeId || !batches.length) return;
    const idx = batches.findIndex(b => b.some(e => e.id === selectedEpisodeId));
    if (idx >= 0) setActiveBatchIdx(idx);
  }, [selectedEpisodeId, batches]); // ← no activeBatchIdx here

  const activeBatch = batches[activeBatchIdx] ?? episodes;

  // Auto-scroll active episode into view in the sidebar.
  // We only scroll when the episode changes *programmatically* (initial load,
  // batch switch) — NOT when the user clicks an episode (it's already visible).
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeEpRef = useRef<HTMLButtonElement>(null);
  // Counter instead of boolean — a single user click triggers TWO effect runs:
  // one for selectedEpisodeId change and one for activeBatchIdx (batch-sync).
  // Setting to 2 skips both, preventing the "scroll to top" jump on click.
  const userClickedEpRef = useRef(0);

  useEffect(() => {
    // If the user just clicked this episode manually, skip scrolling.
    if (userClickedEpRef.current > 0) {
      userClickedEpRef.current--;
      return;
    }
    if (activeEpRef.current && sidebarRef.current) {
      const ep = activeEpRef.current;
      const sb = sidebarRef.current;
      const epTop = ep.offsetTop;
      const epH = ep.offsetHeight;
      const sbH = sb.offsetHeight;
      const sbScrollTop = sb.scrollTop;
      if (epTop < sbScrollTop + 40 || epTop + epH > sbScrollTop + sbH - 40) {
        sb.scrollTo({ top: Math.max(0, epTop - sbH / 3), behavior: "smooth" });
      }
    }
  }, [selectedEpisodeId, activeBatchIdx]);

  // ── Player state ─────────────────────────────────────────────────────────
  const playerRef = useRef<MediaPlayerInstance>(null);

  const [showSeasonModal, setShowSeasonModal] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);

  // Track which providers failed for the current episode so we can flag them
  // in the server list. Resets when the episode changes.
  const [failedProviders, setFailedProviders] = useState<Set<string>>(new Set());

  // Video duration — populated once the video loads and reports its duration.
  // Used to refetch skip-times with `?duration=` so AniSkip can filter
  // contributions by episode length (more accurate, fewer false positives).
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  // Intro/outro skip times for the current episode, resolved server-side
  // (anidb title → MAL id → AniSkip). Silently unavailable for anime AniSkip
  // doesn't know about — the popup simply never shows.
  // Query key includes `videoDuration` so it automatically refetches with the
  // real episode length once the video has loaded, improving AniSkip accuracy.
  const { data: skipTimes } = useQuery({
    queryKey: ["skip-times", id, currentEp?.number, videoDuration ?? 0],
    queryFn: async () => {
      const dur = videoDuration && videoDuration > 0 ? `?duration=${Math.round(videoDuration)}` : "";
      const r = await fetch(apiUrl(`/api/anime/${id}/skip-times/${currentEp!.number}${dur}`), { headers: withClientHeader() });
      if (!r.ok) return { op: null, ed: null };
      return (await r.json()) as {
        op: { start: number; end: number } | null;
        ed: { start: number; end: number } | null;
      };
    },
    enabled: !!id && !!currentEp?.number,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  // Active audio option for display
  const activeLang = selectedLang ?? "sub";

  // ── Auto-select safety — keep Japanese as the hardcoded default ──────────────
  // Japanese ("sub") is the universal default and MUST launch instantly. This
  // effect only kicks in to CORRECT a stale selection — e.g. if the URL had
  // "?lang=dub" but the active provider doesn't actually have a dub track.
  //
  // CRITICAL: this effect NEVER switches AWAY from "sub" (Japanese). If the
  // user is on Japanese and the provider only has Japanese, we leave it
  // alone. If the user is on a dub that doesn't exist, we fall back to
  // Japanese (the universally-available track), never to English.
  useEffect(() => {
    if (currentProviderLoading) return;
    if (currentAudioOptions.length === 0) return; // probe not settled yet
    // Is the currently-selected lang actually available on this provider?
    const selectedAvailable = currentAudioOptions.some(
      (o) => o.code === activeLang
    );
    if (!selectedAvailable && activeLang !== "sub") {
      // Selected dub doesn't exist here — fall back to Japanese (always safe)
      setSelectedLang("sub");
    }
  }, [currentAudioOptions, currentProviderLoading, activeLang]);

  // ── iframe watchdog ─────────────────────────────────────────────────────────
  // For embed-only streams (Core/ReAnime/VidWish), the iframe loads via
  // /api/embed-proxy which itself does a server-side preflight. If the upstream
  // is down, the embed-proxy returns a branded error page (no URL leak). But
  // the iframe can ALSO hang silently — e.g. preflight passed but the actual
  // embed player never finishes loading, or a CDN edge takes 30+ s to respond.
  //
  // This watchdog fires 15s after the iframe URL changes. If `onLoad` hasn't
  // fired by then, we show a branded "Stream Unavailable" overlay over the
  // iframe with a "Switch Server" button — matching the same look as the
  // backend's 502 error page so the UX is consistent.
  //
  // The timeout was 8s originally but that was too aggressive — some legit
  // embed providers (especially FlixCloud/ReAnime multi-track players) take
  // 10-12s to fully initialize on cold CDN edges. 15s gives enough headroom
  // to avoid false "Stream Unavailable" errors on working anime while still
  // catching genuinely hung iframes in reasonable time.
  const [iframeLoaded, setIframeLoaded] = useState(false);
  // (iframeFailed + iframeWatchdogTimer removed — no watchdog timer per user request)

  // ── Minimum logo display time ─────────────────────────────────────────────
  // When the user clicks an episode, the logo overlay should stay visible
  // for AT LEAST this long — even if the iframe fires onLoad faster. This
  // bridges the perceived "gap" between clicking an episode and the video
  // actually being ready to play, so the breathing logo gives the user a
  // polished loading feel instead of an instant flash of black → iframe.
  //
  // The iframe keeps loading in the background during this delay — we just
  // keep the logo overlay up. Once the minimum time elapses AND the iframe
  // has loaded, the overlay fades out smoothly.
  //
  // NOTE: logoReadyToHide MUST be declared BEFORE the useEffect below that
  // references it, otherwise we hit a TDZ (temporal dead zone) ReferenceError
  // that crashes the entire Watch component → blank screen.
  const LOGO_MIN_DISPLAY_MS = 3000;  // 3 seconds minimum (user requested)
  const [logoMountedAt, setLogoMountedAt] = useState<number | null>(null);
  const [logoReadyToHide, setLogoReadyToHide] = useState(false);

  // "logoReadyToHide" — true if minimum display time has elapsed. The actual
  // hide also requires the loading to be done (checked in the visibility
  // condition below), so this is just one of two conditions for hiding.
  useEffect(() => {
    if (!logoMountedAt) {
      setLogoReadyToHide(false);
      return;
    }
    const elapsed = Date.now() - logoMountedAt;
    const remaining = Math.max(0, LOGO_MIN_DISPLAY_MS - elapsed);
    const t = setTimeout(() => setLogoReadyToHide(true), remaining);
    return () => clearTimeout(t);
  }, [logoMountedAt]);

  // Track when the logo overlay first becomes visible (when stream starts
  // loading or when iframe starts loading).
  useEffect(() => {
    const inLoadingState = streamLoading || streamFetching || (stream?.isEmbed === true && !iframeLoaded);
    if (inLoadingState && logoMountedAt === null) {
      setLogoMountedAt(Date.now());
    } else if (!inLoadingState && logoMountedAt !== null && logoReadyToHide) {
      // Reset only after we've actually hidden the overlay
      setLogoMountedAt(null);
    }
  }, [streamLoading, streamFetching, stream?.isEmbed, iframeLoaded, logoMountedAt, logoReadyToHide]);

  // Reset iframe state each time the stream URL or language changes.
  // NO WATCHDOG TIMER — the user explicitly asked us NOT to add an artificial
  // 15s timer. If the iframe errors out, the backend's embed-proxy route
  // already returns a branded error page (handled server-side), and the
  // iframe's onLoad will fire when that error page loads — no timer needed.
  // If the iframe genuinely hangs forever (rare), the logo overlay just
  // stays visible, which is acceptable per the user's preference for
  // "simple" error handling — no fake test, no timer.
  useEffect(() => {
    setIframeLoaded(false);
  }, [stream?.streamUrl, stream?.isEmbed, activeLang]);

  return (
    <>
    <div className="flex flex-col lg:flex-row w-full lg:h-[calc(100dvh-3.5rem)] overflow-hidden bg-[#060609]">

      {/* ── Left: Player + Controls ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto overflow-x-hidden">

        {/* Player */}
        {/* PERF: CSS containment on the player container — prevents layout
            thrashing when the video player initializes and reflows. The
            player's internal layout changes don't bubble up to the rest of
            the page, so the post-transition "settle" lag is reduced.
            Pure CSS — no animation changes. */}
        <div
          className="w-full bg-black shrink-0 relative"
          style={{ contain: "layout style paint" }}
        >

          {/* NOTE: StreamProgressBar (the red bar that animated across the top
              of the player during loading) was REMOVED here per user request.
              The user wanted only the TVDB logo overlay during loading — no
              other red loading indicators anywhere on the watch page. */}

          <AnimatePresence>
            {switchNotice && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 bg-black/85 border border-primary/40 text-white/90 text-[11px] font-semibold rounded-sm shadow-lg backdrop-blur-sm whitespace-nowrap"
              >
                <span>{switchNotice}</span>
                {suggestedProvider && (
                  <button
                    onClick={() => {
                      setActiveProvider(suggestedProvider.id);
                      setSuggestedProvider(null);
                      setSwitchNotice(null);
                    }}
                    className="px-2 py-0.5 bg-primary text-white text-[10px] font-black uppercase tracking-wide rounded-sm hover:bg-primary/80 transition-colors"
                  >
                    Switch to {suggestedProvider.label}
                  </button>
                )}
                <button
                  onClick={() => { setSwitchNotice(null); setSuggestedProvider(null); }}
                  className="text-white/40 hover:text-white transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="w-full aspect-video">
            <AnimatePresence mode="wait">
              {!selectedEpisodeId ? (
                <motion.div key="no-ep" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/20">
                  <Play className="w-16 h-16" />
                  <p className="text-sm font-bold tracking-widest uppercase">Select an episode</p>
                </motion.div>

              ) : streamError || (!streamLoading && !streamFetching && !stream?.streamUrl) ? (
                <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <AlertCircle className="w-12 h-12 text-destructive" />
                  <div className="text-center">
                    <p className="font-bold text-lg mb-1 text-destructive">Stream Unavailable</p>
                    <p className="text-white/40 text-sm">Try another server or episode.</p>
                  </div>
                </motion.div>
              ) : stream?.switchedProvider ? (
                // Backend couldn't get a stream from the requested provider and
                // fell back silently — we refuse to play the fallback and instead
                // tell the user this server is down, letting THEM choose to switch.
                (() => {
                  const requestedLabel = PROVIDER_TABS.find((t) => t.id === activeProvider)?.label ?? activeProvider;
                  const fallbackId = stream.provider as ProviderId | undefined;
                  const fallbackTab = fallbackId ? PROVIDER_TABS.find((t) => t.id === fallbackId) : null;
                  return (
                    <motion.div key="switched" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
                      <AlertCircle className="w-12 h-12 text-yellow-500/80" />
                      <div>
                        <p className="font-bold text-lg mb-1 text-white/90">{requestedLabel} is unavailable right now.</p>
                        <p className="text-white/40 text-sm">Please select another server below.</p>
                      </div>
                      {fallbackTab && (
                        <button
                          onClick={() => setActiveProvider(fallbackTab.id)}
                          className="px-5 py-2.5 bg-primary hover:bg-primary/80 text-white text-sm font-black uppercase tracking-widest rounded-sm transition-colors shadow-[0_0_20px_rgba(220,38,38,0.35)]"
                        >
                          Switch to {fallbackTab.label}
                        </button>
                      )}
                    </motion.div>
                  );
                })()
              ) : (
                // ── MAIN PLAYER STATE ────────────────────────────────────────────
                // Covers BOTH:
                //   a) streamLoading/streamFetching (stream URL not yet resolved)
                //   b) stream URL resolved, iframe/video is loading
                //
                // ONE SINGLE key for both states → no remount, no flicker.
                // The logo overlay is the same component, conditionally shown
                // based on a unified "still loading" check below.
                <motion.div
                  key="player"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="absolute inset-0"
                >
                  {/* Render the iframe/video if we have a stream URL.
                      If we don't yet, the area stays black (covered by the
                      logo overlay below). */}
                  {stream?.streamUrl && stream.isEmbed && (
                    <iframe
                      src={stream.streamUrl}
                      className="w-full h-full border-0"
                      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                      allowFullScreen
                      referrerPolicy="origin"
                      onLoad={() => setIframeLoaded(true)}
                    />
                  )}
                  {stream?.streamUrl && !stream.isEmbed && (
                    <VideoPlayer
                      ref={playerRef}
                      streamUrl={stream.streamUrl}
                      poster={stream.artworkUrl ?? animeDetails?.bannerUrl ?? animeDetails?.posterUrl}
                      title={animeDetails?.title}
                      skipTimes={skipTimes ?? null}
                      onDurationChange={setVideoDuration}
                    />
                  )}

                  {/* SINGLE LOGO OVERLAY ─────────────────────────────────────────
                      Mounts ONCE, stays in place through the entire loading
                      sequence. No flicker, no upar-neeche.

                      Animation: LEFT-TO-RIGHT WIPE REVEAL
                        - Logo is split into TWO layered copies:
                          1. Bottom layer: dim version (opacity ~0.35)
                          2. Top layer: bright version (opacity 1.0) clipped
                             by a mask that sweeps from left → right
                        - The bright version "lights up" the logo progressively
                          from left to right, repeating every 2s
                        - Effect: "small visible → fully visible" sweep across
                          the logo, just like just4anime's loading state
                        - Logo itself stays STATIC (no scale, no up-down)

                      Visibility condition (unified):
                        - We're fetching the stream URL (streamLoading || streamFetching), OR
                        - We have an embed stream URL but the iframe hasn't fired onLoad yet, OR
                        - The minimum display time (LOGO_MIN_DISPLAY_MS = 3.5s) has NOT yet
                          elapsed since the overlay first appeared.

                      z-20 + pointer-events-none so it sits above the iframe
                      but never blocks user clicks. */}
                  <AnimatePresence>
                    {(
                      // Still fetching the stream URL from backend
                      (streamLoading || streamFetching) ||
                      // OR stream URL is ready but iframe is still loading
                      (stream?.isEmbed && !iframeLoaded)
                    ) ? (
                      // Loading is still in progress — show overlay
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.45, ease: "easeOut" }}
                        className="absolute inset-0 bg-black flex items-center justify-center z-20 pointer-events-none"
                      >
                        {logoUrl ? (
                          // Logo with left-to-right wipe reveal
                          <div className="relative inline-flex items-center justify-center">
                            {/* Bottom layer: DIM version of the logo */}
                            <motion.img
                              key={`${logoUrl}-dim`}
                              src={logoUrl}
                              alt=""
                              aria-hidden="true"
                              initial={{ opacity: 0, filter: "blur(8px)" }}
                              animate={{ opacity: 0.35, filter: "blur(0px)" }}
                              transition={{ duration: 0.5, ease: "easeOut" }}
                              className="max-w-[55vw] max-h-[55vh] sm:max-w-[55%] sm:max-h-[55%] w-auto h-auto object-contain"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                            {/* Top layer: BRIGHT version, clipped by a left→right
                                sweeping mask. The bright logo "lights up" from
                                left to right, repeating every 2s. */}
                            <div
                              className="absolute inset-0 pointer-events-none"
                              style={{
                                WebkitMaskImage: "linear-gradient(90deg, #000 0%, #000 50%, transparent 50%, transparent 100%)",
                                maskImage: "linear-gradient(90deg, #000 0%, #000 50%, transparent 50%, transparent 100%)",
                                WebkitMaskSize: "200% 100%",
                                maskSize: "200% 100%",
                                WebkitMaskRepeat: "no-repeat",
                                maskRepeat: "no-repeat",
                                animation: "wipe-reveal 1.5s ease-in-out infinite",
                              }}
                            >
                              <motion.img
                                key={`${logoUrl}-bright`}
                                src={logoUrl}
                                alt=""
                                aria-hidden="true"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
                                className="max-w-[55vw] max-h-[55vh] sm:max-w-[55%] sm:max-h-[55%] w-auto h-auto object-contain"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                            </div>
                          </div>
                        ) : (
                          // No logo available — show a subtle pulsing dot
                          <motion.div
                            className="w-2.5 h-2.5 rounded-full bg-white/40"
                            animate={{
                              opacity: [0.3, 0.9, 0.3],
                            }}
                            transition={{
                              duration: 1.6,
                              repeat: Infinity,
                              ease: "easeInOut",
                            }}
                          />
                        )}
                      </motion.div>
                    ) : logoMountedAt && !logoReadyToHide ? (
                      // Loading is technically done (iframe loaded + stream URL
                      // resolved), but we haven't yet hit the minimum display
                      // time — keep the overlay up so the user sees the
                      // wipe-reveal logo for at least LOGO_MIN_DISPLAY_MS (3s).
                      // The iframe/video is rendering underneath but the overlay
                      // sits on top (z-20) and is pointer-events-none, so playback
                      // can already begin in the background.
                      <motion.div
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.45, ease: "easeOut" }}
                        className="absolute inset-0 bg-black flex items-center justify-center z-20 pointer-events-none"
                      >
                        {logoUrl ? (
                          <div className="relative inline-flex items-center justify-center">
                            <img
                              src={logoUrl}
                              alt=""
                              aria-hidden="true"
                              className="max-w-[55vw] max-h-[55vh] sm:max-w-[55%] sm:max-h-[55%] w-auto h-auto object-contain"
                              style={{ opacity: 0.35 }}
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                            <div
                              className="absolute inset-0 pointer-events-none"
                              style={{
                                WebkitMaskImage: "linear-gradient(90deg, #000 0%, #000 50%, transparent 50%, transparent 100%)",
                                maskImage: "linear-gradient(90deg, #000 0%, #000 50%, transparent 50%, transparent 100%)",
                                WebkitMaskSize: "200% 100%",
                                maskSize: "200% 100%",
                                WebkitMaskRepeat: "no-repeat",
                                maskRepeat: "no-repeat",
                                animation: "wipe-reveal 1.5s ease-in-out infinite",
                              }}
                            >
                              <img
                                src={logoUrl}
                                alt=""
                                aria-hidden="true"
                                className="max-w-[55vw] max-h-[55vh] sm:max-w-[55%] sm:max-h-[55%] w-auto h-auto object-contain"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                            </div>
                          </div>
                        ) : (
                          <motion.div
                            className="w-2.5 h-2.5 rounded-full bg-white/40"
                            animate={{
                              opacity: [0.3, 0.9, 0.3],
                            }}
                            transition={{
                              duration: 1.6,
                              repeat: Infinity,
                              ease: "easeInOut",
                            }}
                          />
                        )}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  {/* NO WATCHDOG OVERLAY — removed per user request.
                      The user wanted "simple" error handling: if the iframe
                      errors out, the backend's embed-proxy route already
                      returns a branded error page that the iframe will
                      display. No artificial 15s timer, no fake "Stream
                      Unavailable" UI. */}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Controls Bar */}
        <div className="shrink-0 px-4 sm:px-5 py-3.5 bg-[#0d0d12] border-b border-white/[0.07] flex flex-col gap-3">

          {/* Row 1: Back + Title + Ep */}
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href={`/anime/${id}`}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-white/5 border border-white/10 text-white/70 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all text-xs font-bold uppercase tracking-widest rounded-sm whitespace-nowrap"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Details
            </Link>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm leading-snug line-clamp-2">{animeDetails?.title || "—"}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {currentEp && (
                  <span className="text-primary text-xs font-bold">
                    Episode {currentEp.number}{currentEp.number2 ? `–${currentEp.number2}` : ""}
                  </span>
                )}
                {currentEp?.filler && (
                  <span className="px-1 py-0.5 bg-orange-500/20 text-orange-400 text-[9px] font-black uppercase tracking-widest rounded-sm">Filler</span>
                )}
                {/* Next episode countdown — capsule style with live clock */}
                {episodesData?.nextAiring && (
                  <span className="inline-flex items-center gap-0 rounded-full border border-emerald-500/25 bg-emerald-500/8 overflow-hidden">
                    <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 text-[9px] font-black uppercase tracking-wide">
                      EP {episodesData.nextAiring.episode}
                    </span>
                    <span className="w-px h-3 bg-emerald-500/20" />
                    <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold tabular-nums text-emerald-300">
                      <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                      {formatCountdown(Math.max(0, episodesData.nextAiring.airsAt - now))}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Row 2: Lang + Quality + Prev/Next */}
          <div className="flex items-center gap-2 flex-wrap">

            {/* Audio (language) selector */}
            {stream?.streamUrl && (
              <button
                onClick={() => setShowAudioModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 border bg-black/30 border-white/10 text-white/70 hover:text-white hover:border-white/25 text-[10px] font-black uppercase tracking-widest rounded-sm transition-all"
              >
                <Headphones className="w-3.5 h-3.5" />
                {/* Use currentAudioOptions (active provider only) so the label
                    never falsely claims "English Dub" when the active provider
                    only has Japanese. */}
                {getAudioLabel(activeLang, currentAudioOptions, stream.isHardSub)}
                <ChevronDown className="w-3 h-3 text-white/30" />
              </button>
            )}

            {/* Server (provider) selector — compact popup trigger, mirrors
                the Season selector pattern instead of a flat tab row. Only
                the chosen provider is ever fetched; picking one here closes
                the sheet and switches instantly. */}
            <button
              onClick={() => setShowProviderModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 border bg-black/30 border-white/10 text-white/70 hover:text-white hover:border-white/25 text-[10px] font-black uppercase tracking-widest rounded-sm transition-all"
            >
              <Menu className="w-3.5 h-3.5" />
              {PROVIDER_TABS.find((t) => t.id === activeProvider)?.label ?? activeProvider}
              <ChevronDown className="w-3 h-3 text-white/30" />
            </button>

            {/* Prev / Next */}
            <div className="flex items-center gap-1 ml-auto">
              <button
                disabled={!prevEp}
                onClick={() => prevEp && selectEpisode(prevEp.id)}
                title="Previous Episode"
                className="w-8 h-8 flex items-center justify-center bg-black/30 border border-white/10 text-white disabled:opacity-20 disabled:cursor-not-allowed hover:bg-primary hover:border-primary transition-all rounded-sm"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={!nextEp}
                onClick={() => nextEp && selectEpisode(nextEp.id)}
                title="Next Episode"
                className="w-8 h-8 flex items-center justify-center bg-black/30 border border-white/10 text-white disabled:opacity-20 disabled:cursor-not-allowed hover:bg-primary hover:border-primary transition-all rounded-sm"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right: Episode Sidebar ──────────────────────────────────────── */}
      <div className="w-full lg:w-[340px] xl:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-white/[0.07] bg-[#0a0a0f] flex flex-col h-[65vh] lg:h-full">

        {/* Sidebar header */}
        <div className="px-4 py-3.5 border-b border-white/[0.07] bg-black/20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Tv2 className="w-4 h-4 text-primary shrink-0" />
            <h2 className="font-display font-black text-base text-white truncate flex-1">
              {animeDetails?.title || "Episodes"}
            </h2>
            <span className="text-xs font-bold text-white/30 shrink-0">
              {airedEpisodes.length} EP{airedEpisodes.length !== 1 ? "S" : ""}
            </span>
          </div>
        </div>

        {/* Season selector — tap to open full-screen modal */}
        {seasons.length > 1 && (
          <div className="px-3 py-2 border-b border-white/[0.07] bg-black/10 shrink-0">
            <button
              onClick={() => setShowSeasonModal(true)}
              className="w-full flex items-center justify-between px-3 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-primary/30 transition-all rounded-sm text-left group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Layers className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-[11px] font-bold text-white/70 truncate group-hover:text-white transition-colors">
                  {seasons.find(s => s.isCurrent)?.title ?? seasons[0]?.title ?? "Season 1"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <span className="text-[9px] font-black text-white/25 uppercase tracking-widest">{seasons.length} Seasons</span>
                <ChevronDown className="w-3.5 h-3.5 text-white/25 group-hover:text-white/50 transition-colors" />
              </div>
            </button>
          </div>
        )}

        {/* Batch range selector */}
        {batches.length > 1 && (
          <div className="px-2.5 py-2 border-b border-white/[0.07] bg-black/10 shrink-0 flex gap-1.5 overflow-x-auto no-scrollbar">
            {batches.map((batch, i) => {
              const first = batch[0]!.number;
              const last = batch[batch.length - 1]!.number;
              const isActive = i === activeBatchIdx;
              return (
                <button
                  key={i}
                  onClick={() => setActiveBatchIdx(i)}
                  className={cn(
                    "px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest whitespace-nowrap rounded-sm transition-all border shrink-0",
                    isActive
                      ? "bg-primary text-white border-primary shadow-[0_0_8px_rgba(220,38,38,0.3)]"
                      : "bg-transparent text-white/40 border-white/10 hover:text-white hover:border-white/25"
                  )}
                >
                  {first}–{last}
                </button>
              );
            })}
          </div>
        )}

        {/* Episode list */}
        <div ref={sidebarRef} className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {episodesLoading ? (
            <div className="flex flex-col gap-1.5 p-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-[70px] w-full shimmer rounded-sm" />
              ))}
            </div>
          ) : episodesError ? (
            <div className="flex items-center justify-center h-32 text-sm text-destructive font-bold">
              Failed to load episodes.
            </div>
          ) : activeBatch.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              No episodes found.
            </div>
          ) : (
            activeBatch.map((ep) => {
              const isSelected = selectedEpisodeId === ep.id;
              const aired = isEpisodeAired(ep);
              return (
                <button
                  key={ep.id}
                  ref={isSelected ? activeEpRef : undefined}
                  onClick={() => aired && selectEpisode(ep.id)}
                  onPointerEnter={() => aired && !isSelected && prefetchEpisodeStream(ep.id)}
                  disabled={!aired}
                  title={!aired ? "Not yet aired" : undefined}
                  style={{
                    // ── PERF: content-visibility auto-skips rendering for offscreen
                    // episode buttons. Huge win for long-running anime (One Piece =
                    // 1175 episodes). contain-intrinsic-size gives the browser a
                    // placeholder height so scroll position stays stable before
                    // the real content paints. Pure CSS — no animation changes.
                    contentVisibility: "auto",
                    containIntrinsicSize: "70px",
                  }}
                  className={cn(
                    "flex gap-3 p-2 w-full text-left transition-all relative rounded-sm overflow-hidden border group",
                    !aired
                      ? "opacity-40 cursor-not-allowed bg-transparent border-transparent"
                      : isSelected
                      ? "bg-white/8 border-white/10"
                      : "bg-transparent border-transparent hover:bg-white/4 hover:border-white/6"
                  )}
                >
                  {/* Active indicator */}
                  {isSelected && (
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary shadow-[0_0_8px_rgba(220,38,38,0.7)]" />
                  )}

                  {/* Thumbnail — 16:9 episode screenshot or anime poster fallback */}
                  <div className="w-[88px] shrink-0 aspect-video bg-white/5 overflow-hidden relative rounded-sm border border-white/[0.08] shadow-md">
                    {(ep.thumbnail || animeDetails?.posterUrl) && (
                      <img
                        src={ep.thumbnail || animeDetails?.posterUrl}
                        loading="lazy"
                        decoding="async"
                        className={cn(
                          "w-full h-full object-cover transition-transform duration-500",
                          isSelected ? "scale-105" : "group-hover:scale-110"
                        )}
                        alt=""
                      />
                    )}
                    {!aired && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <Lock className="w-3 h-3 text-white/40" />
                      </div>
                    )}
                    {aired && isSelected && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                        <Play className="w-4 h-4 fill-white text-white" />
                      </div>
                    )}
                    {aired && !isSelected && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <Play className="w-4 h-4 fill-white text-white" />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center py-0.5">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className={cn(
                        "text-[9px] font-black px-1.5 py-0.5 rounded-sm tracking-widest shrink-0",
                        isSelected ? "bg-primary text-white" : "bg-white/10 text-white/60"
                      )}>
                        EP {ep.number}
                      </span>
                      {ep.filler && (
                        <span className="text-[9px] font-black text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded-sm tracking-widest">
                          FILLER
                        </span>
                      )}
                      {!aired && ep.airsAt && (
                        /* Next episode: live countdown */
                        <span className="flex items-center gap-0.5 text-[9px] font-black text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded-sm tracking-widest">
                          <Clock className="w-2 h-2" />
                          {formatCountdown(Math.max(0, ep.airsAt - now))}
                        </span>
                      )}
                      {!aired && !ep.airsAt && (
                        <span className="flex items-center gap-0.5 text-[9px] font-black text-white/30 bg-white/5 px-1.5 py-0.5 rounded-sm tracking-widest">
                          <Lock className="w-2 h-2" /> NOT YET AIRED
                        </span>
                      )}
                    </div>
                    <p className={cn(
                      "text-[11px] font-semibold leading-snug transition-colors",
                      !aired ? "text-white/30" : isSelected ? "text-white" : "text-white/55 group-hover:text-white/80"
                    )}>
                      {ep.title || `Episode ${ep.number}${ep.number2 ? `–${ep.number2}` : ""}`}
                    </p>
                    {aired && (
                      <div className="flex items-center gap-1 mt-0.5">
                        {ep.hasSub !== false && <span className="text-[9px] text-white/30 font-bold uppercase tracking-widest">Sub</span>}
                        {ep.hasSub !== false && ep.hasDub !== false && <span className="text-[10px] text-white/15">·</span>}
                        {ep.hasDub !== false && <span className="text-[9px] text-white/30 font-bold uppercase tracking-widest">Dub</span>}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
          {!episodesLoading && !episodesError && activeBatch.length > 0 && (
            <p className="text-center text-[10px] font-black uppercase tracking-widest text-white/20 py-4">
              You reached the end
            </p>
          )}
        </div>
      </div>
    </div>

    {/* ── Audio Modal (bottom-sheet) ──────────────────────────────────── */}
    {createPortal(
      <AnimatePresence>
        {showAudioModal && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setShowAudioModal(false)}
            />
            <motion.div
              className="relative w-full max-w-md bg-[#0d0d12] border-t border-white/10 rounded-t-2xl flex flex-col z-10 overflow-hidden"
              style={{ maxHeight: "min(70dvh, 420px)" }}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 300 }}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07] shrink-0">
                <div className="flex items-center gap-2">
                  <Headphones className="w-4 h-4 text-primary" />
                  <span className="font-black text-base text-white">Audio</span>
                  <span className="text-xs text-white/30 font-bold ml-1">Sub &amp; Dub</span>
                </div>
                <button
                  onClick={() => setShowAudioModal(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-white/50 hover:text-white transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1 p-2">
                {/* ── AUDIO MODAL — shows ONLY what the active server supports ──
                    No more hardcoded "Japanese (sub)" at the top. The list is
                    driven entirely by `currentAudioOptions` (returned by the
                    backend's /pop-based audio-options probe for the active
                    provider). If the active server doesn't have hsub, it
                    simply won't appear here.

                    Labels are HARDCODED by the backend per the spec:
                      sub  → "Japanese"
                      dub  → "English"
                      hsub → "Japanese (H-Sub)"  (only AniNico ever has this)

                    While the probe is in-flight, show a "Loading audio
                    options…" hint instead of placeholders — the stream itself
                    does NOT wait for this probe, so Japanese still launches
                    instantly via selectedLang="sub" before the modal opens. */}

                {(() => {
                  // Probe in-flight: empty list = backend hasn't responded yet.
                  // Show a subtle loading hint instead of false options.
                  if (currentAudioOptions.length === 0) {
                    return (
                      <div className="px-4 py-3">
                        <p className="text-white/30 text-[11px] font-semibold">
                          Loading audio options…
                        </p>
                      </div>
                    );
                  }

                  // Stable order: sub first (Japanese), then dub (English),
                  // then hsub (Japanese H-Sub) — matches how the user expects
                  // audio options to be listed.
                  const ORDER = ["sub", "dub", "hsub"];
                  const sorted = [...currentAudioOptions].sort(
                    (a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code)
                  );

                  return (
                    <div>
                      {sorted.map(({ code, label }) => {
                        const isActive = activeLang === code;
                        // Trust the backend's label, but fall back to the same
                        // hardcoded mapping in case the backend omits a label.
                        const displayLabel =
                          label ||
                          (code === "sub"  ? "Japanese"
                          : code === "dub"  ? "English"
                          : code === "hsub" ? "Japanese (H-Sub)"
                          : code.charAt(0).toUpperCase() + code.slice(1));
                        return (
                          <button
                            key={code}
                            onClick={() => selectAudio(code)}
                            className={cn(
                              "w-full flex items-center justify-between px-4 py-3 text-left text-sm font-bold rounded-sm transition-all",
                              isActive
                                ? "bg-primary/15 text-primary"
                                : "text-white/60 hover:text-white hover:bg-white/5"
                            )}
                          >
                            <span className="flex items-center gap-2">
                              {displayLabel}
                            </span>
                            {isActive && (
                              <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(220,38,38,0.6)]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body
    )}

    {/* ── Server (provider) Modal (bottom-sheet) — mirrors Season modal ── */}
    {createPortal(
      <AnimatePresence>
        {showProviderModal && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setShowProviderModal(false)}
            />
            {/* Sheet */}
            <motion.div
              className="relative w-full max-w-md bg-[#0d0d12] border-t border-white/10 rounded-t-2xl flex flex-col z-10 overflow-hidden"
              style={{ maxHeight: "min(70dvh, 460px)" }}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 300 }}
            >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07] shrink-0">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                <span className="font-black text-base text-white">Servers</span>
                <span className="text-xs text-white/30 font-bold ml-1">{PROVIDER_TABS.length} available</span>
              </div>
              <button
                onClick={() => setShowProviderModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-white/50 hover:text-white transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {PROVIDER_TABS.map((tab) => {
                const isActive = activeProvider === tab.id;
                const hasFailed = failedProviders.has(tab.id) && !isActive;
                const options = audioOptionsByProvider[tab.id] ?? [];
                return (
                  <button
                    key={tab.id}
                    onClick={() => { setActiveProvider(tab.id); setShowProviderModal(false); }}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-3 text-left text-sm font-bold rounded-sm transition-all",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : hasFailed
                          ? "text-red-500/50 hover:text-red-400 hover:bg-red-500/5"
                          : "text-white/60 hover:text-white hover:bg-white/5"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {tab.recommended && !hasFailed && (
                        <Star className="w-3 h-3 fill-yellow-400 text-yellow-400 shrink-0" />
                      )}
                      {hasFailed && (
                        <AlertCircle className="w-3 h-3 text-red-500/60 shrink-0" />
                      )}
                      {tab.label}
                      {tab.recommended && !hasFailed && (
                        <span className="text-[9px] font-black uppercase tracking-widest text-yellow-500/60">
                          Recommended
                        </span>
                      )}
                      {hasFailed && (
                        <span className="text-[9px] font-black uppercase tracking-widest text-red-500/50">
                          Unavailable
                        </span>
                      )}
                      {!tab.recommended && !hasFailed && options.length > 0 && (
                        <span className="text-[9px] font-black uppercase tracking-widest text-white/25">
                          {options.map((o) => o.label).join(" / ")}
                        </span>
                      )}
                    </span>
                    {isActive && (
                      <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(220,38,38,0.6)]" />
                    )}
                  </button>
                );
              })}
            </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body
    )}

    {/* ── Season Modal (fullscreen bottom-sheet) ──────────────────────── */}
    {createPortal(
      <AnimatePresence>
        {showSeasonModal && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setShowSeasonModal(false)}
            />
            {/* Sheet */}
            <motion.div
              className="relative w-full max-w-2xl bg-[#0d0d12] border-t border-white/10 rounded-t-2xl max-h-[82vh] flex flex-col z-10 overflow-hidden"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 280 }}
            >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07] shrink-0">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" />
                <span className="font-black text-base text-white">Seasons</span>
                <span className="text-xs text-white/30 font-bold ml-1">{seasons.length} entries</span>
              </div>
              <button
                onClick={() => setShowSeasonModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-white/50 hover:text-white transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Grid */}
            <div className="overflow-y-auto flex-1 p-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {seasons.map((s, idx) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setShowSeasonModal(false);
                      if (!s.isCurrent) setLocation(`/watch/${s.id}`);
                    }}
                    className={cn(
                      "group text-left relative rounded-sm overflow-visible",
                      s.isCurrent ? "ring-2 ring-primary ring-offset-1 ring-offset-[#0d0d12]" : ""
                    )}
                  >
                    <div className="w-full aspect-[2/3] overflow-hidden border border-white/10 rounded-sm relative">
                      <img
                        src={s.posterUrl ?? `https://img.anili.st/media/${s.id}`}
                        alt={s.title}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                      {/* Overlay on hover */}
                      {!s.isCurrent && (
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Play className="w-6 h-6 fill-white text-white" />
                        </div>
                      )}
                      {/* Season badge */}
                      <div className={cn(
                        "absolute top-1.5 left-1.5 w-6 h-6 rounded-sm flex items-center justify-center text-[10px] font-black shadow-lg",
                        s.isCurrent ? "bg-primary text-white" : "bg-black/70 text-white/80"
                      )}>
                        {idx + 1}
                      </div>
                      {/* NOW badge */}
                      {s.isCurrent && (
                        <div className="absolute top-1.5 right-1.5 px-1 py-0.5 bg-emerald-500 text-white text-[7px] font-black uppercase tracking-widest rounded-sm">
                          NOW
                        </div>
                      )}
                    </div>
                    <p className={cn(
                      "mt-1.5 text-[9px] font-semibold line-clamp-2 leading-tight px-0.5",
                      s.isCurrent ? "text-white" : "text-white/55 group-hover:text-white/80"
                    )}>
                      {s.title}
                    </p>
                  </button>
                ))}
              </div>
            </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body
    )}
    </>
  );
}

// ── HLS Video Player (Vidstack) ─────────────────────────────────────────────
//
// A fixed aspect-ratio container + `object-contain` media keeps the layout
// stable no matter what resolution/ratio the current stream is — the
// previous manual <video>+Plyr setup let the control bar's layout shift
// around based on the video's native size, which is what caused the
// floating/misaligned overlay some episodes showed.

interface SkipInterval { start: number; end: number }
interface SkipTimes { op: SkipInterval | null; ed: SkipInterval | null }

// Build a WebVTT chapters blob URL from AniSkip timestamps + video duration.
// Vidstack renders chapter boundaries as visual "crack" dividers in the seekbar.
// Returns a blob: URL (caller is responsible for revoking it via URL.revokeObjectURL).
function buildChaptersBlobUrl(skipTimes: SkipTimes, duration: number): string | null {
  if (!duration || duration < 5) return null;
  if (!skipTimes.op && !skipTimes.ed) return null;

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3).padStart(6, "0");
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`
      : `${String(m).padStart(2, "0")}:${sec}`;
  };

  type Seg = { start: number; end: number; label: string };
  const segs: Seg[] = [];

  if (skipTimes.op) {
    // Only add a "Cold Open" segment if the OP genuinely starts after the
    // first few seconds — avoids a meaningless 1-second Cold Open segment
    // when AniSkip reports startTime=1 (OP is essentially from the start).
    if (skipTimes.op.start > 3) {
      segs.push({ start: 0, end: skipTimes.op.start, label: "Cold Open" });
    }
    segs.push({ start: skipTimes.op.start, end: skipTimes.op.end, label: "Opening" });
  }

  const mainStart = skipTimes.op?.end ?? 0;
  const mainEnd = skipTimes.ed?.start ?? duration;
  if (mainEnd > mainStart + 1) {
    segs.push({ start: mainStart, end: mainEnd, label: "Episode" });
  }

  if (skipTimes.ed) {
    const edEnd = Math.min(skipTimes.ed.end, duration);
    segs.push({ start: skipTimes.ed.start, end: edEnd, label: "Ending" });
    if (edEnd < duration - 2) {
      segs.push({ start: edEnd, end: duration, label: "Post Credits" });
    }
  }

  if (segs.length === 0) return null;

  const cues = segs
    .map((s) => `${fmt(s.start)} --> ${fmt(s.end)}\n${s.label}`)
    .join("\n\n");

  const blob = new Blob([`WEBVTT\n\n${cues}`], { type: "text/vtt" });
  return URL.createObjectURL(blob);
}

// ── ChaptersTrack ───────────────────────────────────────────────────────────
// Must be a CHILD of <MediaPlayer> so that useMediaState() has access to the
// player context. Calling useMediaState at the VideoPlayer level (which renders
// <MediaPlayer>) would be outside the context boundary → duration always 0.
function ChaptersTrack({
  skipTimes,
  onDurationChange,
}: {
  skipTimes: SkipTimes | null;
  onDurationChange?: (duration: number) => void;
}) {
  const duration = useMediaState("duration");

  // Tell the parent the real episode length so it can refetch skip-times
  // with ?duration= for more accurate AniSkip episodeLength matching.
  useEffect(() => {
    if (duration && duration > 0) onDurationChange?.(duration);
  }, [duration, onDurationChange]);

  // Build the WebVTT blob URL for seekbar chapter dividers ("cracks").
  const chaptersUrl = useMemo(
    () => (skipTimes && duration > 0 ? buildChaptersBlobUrl(skipTimes, duration) : null),
    [skipTimes, duration],
  );

  // Revoke the previous blob URL whenever it changes or the component unmounts.
  useEffect(() => {
    return () => { if (chaptersUrl) URL.revokeObjectURL(chaptersUrl); };
  }, [chaptersUrl]);

  if (!chaptersUrl) return null;
  return <Track kind="chapters" src={chaptersUrl} language="en-US" default />;
}

const VideoPlayer = forwardRef<MediaPlayerInstance, {
  streamUrl: string;
  poster?: string;
  title?: string;
  skipTimes: SkipTimes | null;
  onDurationChange?: (duration: number) => void;
}>(function VideoPlayer({ streamUrl, poster, title, skipTimes, onDurationChange }, ref) {
  const localRef = useRef<MediaPlayerInstance>(null);

  const setRefs = useCallback((instance: MediaPlayerInstance | null) => {
    (localRef as React.MutableRefObject<MediaPlayerInstance | null>).current = instance;
    if (typeof ref === "function") ref(instance);
    else if (ref) (ref as React.MutableRefObject<MediaPlayerInstance | null>).current = instance;
  }, [ref]);

  // Use our already-installed hls.js instead of Vidstack's default behaviour
  // of dynamically importing it from a CDN at runtime.
  const onProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) {
      provider.library = Hls;
    }
  }, []);

  return (
    <MediaPlayer
      ref={setRefs}
      className="w-full h-full"
      src={{ src: streamUrl, type: "application/x-mpegurl" }}
      poster={poster}
      title={title}
      aspectRatio="16/9"
      playsInline
      crossOrigin
      autoPlay
      onProviderChange={onProviderChange}
    >
      <MediaProvider>
        {/* ChaptersTrack lives inside MediaPlayer so useMediaState works */}
        <ChaptersTrack skipTimes={skipTimes} onDurationChange={onDurationChange} />
      </MediaProvider>
      <DefaultVideoLayout
        icons={defaultLayoutIcons}
        // Override the default buffering spinner (the red spinning circle that
        // appears on top of our logo overlay during stream loading). We
        // replace it with an empty fragment so only OUR logo overlay shows
        // during the load state — the Vidstack player never shows its own
        // spinner. Once the stream is ready, playback just starts.
        slots={{ bufferingIndicator: () => null }}
      />
      <SkipButton skipTimes={skipTimes} />
    </MediaPlayer>
  );
});

// ── Skip intro/outro popup ───────────────────────────────────────────────
//
// Deliberately not a static always-there button: it only appears while
// playback is inside the op/ed window, auto-dismisses after a few seconds,
// and clicking it seeks past the segment. Ignoring it does nothing — no
// auto-skip. Positioned bottom-right of the video itself (Crunchyroll-style)
// so it works the same in fullscreen and normal/half-screen layouts.
function SkipButton({ skipTimes }: { skipTimes: SkipTimes | null }) {
  const currentTime = useMediaState("currentTime");
  const remote = useMediaRemote();
  const [dismissedFor, setDismissedFor] = useState<"op" | "ed" | null>(null);
  const [hidden, setHidden] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active: { type: "op" | "ed"; interval: SkipInterval; label: string } | null = useMemo(() => {
    if (!skipTimes) return null;
    if (skipTimes.op && currentTime >= skipTimes.op.start && currentTime < skipTimes.op.end) {
      return { type: "op", interval: skipTimes.op, label: "Skip Intro" };
    }
    if (skipTimes.ed && currentTime >= skipTimes.ed.start && currentTime < skipTimes.ed.end) {
      return { type: "ed", interval: skipTimes.ed, label: "Skip Outro" };
    }
    return null;
  }, [skipTimes, currentTime]);

  // Reset dismissal once playback leaves the segment, so the popup can
  // show again next time (e.g. rewatching, or the outro on a later ep).
  useEffect(() => {
    if (!active) {
      setDismissedFor(null);
      setHidden(false);
    }
  }, [active]);

  // Auto-dismiss a few seconds after appearing, per segment.
  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (active && dismissedFor !== active.type) {
      setHidden(false);
      hideTimerRef.current = setTimeout(() => setHidden(true), 6000);
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [active, dismissedFor]);

  if (!active || dismissedFor === active.type || hidden) return null;

  return (
    <div className="absolute right-3 bottom-20 sm:right-6 sm:bottom-24 z-40 pointer-events-none">
      <motion.button
        key={active.type}
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.96 }}
        transition={{ duration: 0.18 }}
        onClick={() => {
          remote.seek(active.interval.end);
          setDismissedFor(active.type);
        }}
        className="pointer-events-auto flex items-center gap-2 px-4 py-2.5 bg-black/80 backdrop-blur-sm border border-white/20 text-white text-sm font-bold tracking-wide hover:bg-primary hover:border-primary transition-colors rounded-sm shadow-2xl"
      >
        {active.label}
        <ChevronsRight className="w-4 h-4" />
      </motion.button>
    </div>
  );
}
