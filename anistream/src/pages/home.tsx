import { Link, useLocation } from "wouter";
import { Play, Info, ChevronLeft, ChevronRight, Tv2, Film, Calendar, Clock, Zap, Star, Plus, Flame, Trophy, TrendingUp, Sparkles, Swords, History } from "lucide-react";
import { AnimeCard } from "../components/anime-card";
import { RowSlider } from "../components/row-slider";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import { apiUrl } from "../lib/api";
import { withClientHeader } from "../lib/custom-fetch";
import { useContinueWatching } from "../lib/continue-watching";
import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { squishyTap } from "../lib/transitions";

/** Colorful badge classes for TV/Movie/OVA/ONA — consistent with anime-card */
function heroTypeBadgeClasses(label: string | null) {
  switch (label) {
    case "TV":      return "bg-blue-500/20 border-blue-400/35 text-blue-300 shadow-[0_0_8px_rgba(59,130,246,0.3)]";
    case "Movie":   return "bg-violet-500/20 border-violet-400/35 text-violet-300 shadow-[0_0_8px_rgba(229,43,80,0.3)]";
    case "OVA":     return "bg-cyan-500/20 border-cyan-400/35 text-cyan-300 shadow-[0_0_8px_rgba(6,182,212,0.3)]";
    case "ONA":     return "bg-emerald-500/20 border-emerald-400/35 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]";
    default:        return "bg-black/55 border-white/15 text-white/80";
  }
}

/** Map common section titles to a coloured icon */
const SECTION_META: Record<string, { icon: React.ComponentType<{ className?: string }>, color: string }> = {
  "trending now":           { icon: Flame,      color: "text-orange-400" },
  "trending":               { icon: Flame,      color: "text-orange-400" },
  "popular this season":    { icon: TrendingUp, color: "text-sky-400" },
  "popular":                { icon: TrendingUp, color: "text-sky-400" },
  "top rated":              { icon: Trophy,     color: "text-amber-400" },
  "top airing":             { icon: Zap,        color: "text-yellow-400" },
  "new releases":           { icon: Sparkles,   color: "text-emerald-400" },
  "new":                    { icon: Sparkles,   color: "text-emerald-400" },
  "action":                 { icon: Swords,     color: "text-red-400" },
};
function sectionMeta(title: string) {
  return SECTION_META[title.toLowerCase()] ?? null;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface AnimeItem { id: number; title: string; posterUrl: string; type?: string | null; year?: number | null; rating?: number | null; }
interface HomeSection { title: string; items: AnimeItem[]; }
interface BrowseGenre { label: string; slug: string; }
interface HeroItem {
  id: number; title: string; type?: string | null; year?: number | null;
  status?: string | null; rating?: number | null; description?: string | null;
  posterUrl: string; bannerUrl?: string | null;
  nextAiringEpisode?: { episode: number; timeUntilAiring: number } | null;
  season?: string | null; episodeCount?: number | null;
  genres?: string[] | null;
}
interface UpcomingItem {
  id: number; title: string; posterUrl: string;
  type?: string | null; year?: number | null; episodeCount?: number | null;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useHomeSections() {
  return useQuery<{ hero: HeroItem[]; sections: HomeSection[]; genres?: BrowseGenre[] }>({
    queryKey: ["home-sections"],
    queryFn: () => fetch(apiUrl("/api/home"), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: 8 * 60 * 1000,
  });
}
function useUpcoming() {
  return useQuery<{ items: UpcomingItem[] }>({
    queryKey: ["upcoming"],
    queryFn: () => fetch(apiUrl("/api/upcoming"), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function useNow(enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}
function fmtCountdown(secs: number) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${String(m).padStart(2,'0')}m`;
  return `in ${String(m).padStart(2,'0')}:${String(secs % 60).padStart(2,'0')}`;
}

function typeShort(t?: string | null) {
  if (!t) return null;
  const u = t.toUpperCase();
  if (u === "TV" || u === "ANIME") return "TV";
  if (u === "MOVIE") return "Movie";
  if (u === "OVA") return "OVA";
  if (u === "ONA") return "ONA";
  return t;
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function HeroBanner({ items }: { items: HeroItem[] }) {
  const total = Math.min(items.length, 8);
  const [idx, setIdx] = useState(0);
  const [loadedImages, setLoadedImages] = useState<Record<number, boolean>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const now = useNow(items.some(i => !!i.nextAiringEpisode));

  function resetTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setIdx(i => (i + 1) % total), 7000);
  }
  useEffect(() => {
    if (total <= 1) return;
    resetTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [total]);

  function goTo(i: number) { setIdx(i); resetTimer(); }
  if (!total) return null;

  return (
    <div className="relative w-full overflow-hidden bg-[#08090f] -mt-14"
      style={{ height: "calc(var(--hero-height) + 3.5rem)" }}>

      {items.slice(0, 8).map((item, i) => {
        const desktopSrc = item.bannerUrl ?? item.posterUrl;
        const isActive = i === idx;
        const imageLoaded = !!loadedImages[item.id];
        const secs = item.nextAiringEpisode
          ? Math.max(0, Math.floor(item.nextAiringEpisode.timeUntilAiring - (now - Date.now()) / 1000))
          : 0;
        const genres = (item.genres ?? []).slice(0, 4);
        const typeLabel = typeShort(item.type);
        const trendRank = i + 1;

        return (
          <div key={item.id}
            className="absolute inset-0 transition-opacity duration-700"
            style={{ opacity: isActive ? 1 : 0, zIndex: isActive ? 10 : 0, pointerEvents: isActive ? 'auto' : 'none' }}
          >
            {/* Background artwork */}
            <picture className="absolute inset-0 block">
              <source media="(max-width: 767px)" srcSet={item.posterUrl} />
              <img src={desktopSrc} alt="" aria-hidden
                loading={i < 2 ? "eager" : "lazy"}
                fetchPriority={isActive ? "high" : "auto"}
                onLoad={() => setLoadedImages(current => ({ ...current, [item.id]: true }))}
                className={cn(
                  "absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-500 ease-out",
                  /* Mobile: portrait poster — center vertically at 28% to show faces */
                  "object-[center_28%] md:object-[center_20%]",
                  imageLoaded ? "opacity-100 scale-100" : "opacity-0 scale-[1.015]",
                )}
              />
            </picture>

            {!imageLoaded && isActive && (
              <div className="absolute inset-0 shimmer opacity-35" aria-hidden />
            )}

            {/* Gradient overlays — improved for premium feel
                Bottom: stronger fade for text legibility
                Left: subtle vignette for depth */}
            <div className="absolute inset-0 bg-gradient-to-t from-[#08090f] via-[#08090f]/60 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#08090f]/80 via-[#08090f]/25 to-transparent" />

            {/* Content */}
            <div className="absolute bottom-0 left-0 right-0 px-4 sm:px-8 pb-14 sm:pb-16 space-y-3">

              {/* Top badges row */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Type badge */}
                {typeLabel && (
                  <span className={cn(
                    "flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-lg border",
                    heroTypeBadgeClasses(typeLabel)
                  )}>
                    {typeLabel === "Movie" ? <Film className="w-3 h-3" /> : <Tv2 className="w-3 h-3" />}
                    {typeLabel}
                  </span>
                )}

                {/* Trending rank */}
                {trendRank <= 3 && (
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-lg bg-primary/90 text-white shadow-[0_0_10px_rgba(229,43,80,0.4)]">
                    <Flame className="w-3 h-3 fill-white" />
                    #{trendRank} Trending
                  </span>
                )}

                {/* Status badge */}
                {item.status && (
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg border",
                    item.status === "RELEASING"
                      ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/25"
                      : item.status === "NOT_YET_RELEASED"
                      ? "text-yellow-400 bg-yellow-400/10 border-yellow-400/25"
                      : "text-white/50 bg-white/5 border-white/10"
                  )}>
                    {item.status === "RELEASING" ? "Releasing" : item.status === "NOT_YET_RELEASED" ? "Upcoming" : item.status}
                  </span>
                )}

                {/* Season + year */}
                {item.season && item.year && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-white/50">
                    <Calendar className="w-3 h-3" />{item.season} {item.year}
                  </span>
                )}
              </div>

              {/* Title — bigger, bolder, more premium */}
              <h1 className="font-display font-black text-white leading-[1.05] tracking-tight drop-shadow-2xl line-clamp-2"
                style={{ fontSize: "clamp(1.5rem, 6vw, 3rem)" }}>
                {item.title}
              </h1>

              {/* Rating + meta row */}
              <div className="flex flex-wrap items-center gap-1.5">
                {item.rating != null && (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.7)]">
                    <Star className="w-3 h-3 fill-yellow-400" />{item.rating.toFixed(1)}
                  </span>
                )}
                {item.rating != null && <span className="text-white/20 text-[10px]">•</span>}
                {typeLabel && (
                  <span className="text-[11px] font-medium text-white/55">{typeLabel}</span>
                )}
                {typeLabel && <span className="text-white/20 text-[10px]">•</span>}
                {item.nextAiringEpisode && (
                  <>
                    <span className="flex items-center gap-1 text-[11px] font-medium text-sky-400">
                      <Clock className="w-3 h-3" />Ep {item.nextAiringEpisode.episode} {fmtCountdown(secs)}
                    </span>
                    <span className="text-white/20 text-[10px]">•</span>
                  </>
                )}
                {!item.nextAiringEpisode && item.episodeCount && (
                  <>
                    <span className="text-[11px] font-medium text-white/55">{item.episodeCount} Episodes</span>
                    <span className="text-white/20 text-[10px]">•</span>
                  </>
                )}
                <span className="text-[9px] font-bold border border-emerald-400/40 text-emerald-400/80 bg-emerald-400/10 px-1.5 py-0.5 rounded shadow-[0_0_6px_rgba(52,211,153,0.25)]">HD</span>
              </div>

              {/* Genre tags */}
              {genres.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {genres.map((g, gi) => {
                    const hues = ["text-rose-300 border-rose-400/30 bg-rose-400/10","text-sky-300 border-sky-400/30 bg-sky-400/10","text-violet-300 border-violet-400/30 bg-violet-400/10","text-amber-300 border-amber-400/30 bg-amber-400/10"];
                    return (
                      <span key={g} className={cn("text-[10px] font-medium px-2.5 py-1 rounded-full border", hues[gi % hues.length])}>
                        {g}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2.5 pt-1">
                {/* Red Watch Now — squishy */}
                <motion.div whileTap={squishyTap} style={{ willChange: "transform" }}>
                <Link href={`/watch/${item.id}`}
                  className="tap-scale-strong flex items-center gap-2 px-5 py-2.5 bg-primary text-white font-bold text-sm rounded-xl
                    hover:bg-primary/90 transition-colors shadow-[0_4px_20px_rgba(229,43,80,0.45)] whitespace-nowrap"
                >
                  <Play className="w-4 h-4 fill-white" />Watch Now
                </Link>
                </motion.div>

                {/* My List */}
                <motion.div whileTap={squishyTap} style={{ willChange: "transform" }}>
                <Link href={`/anime/${item.id}`}
                  className="tap-scale flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 border border-white/20
                    text-white text-sm font-semibold hover:bg-white/18 transition-colors whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />My List
                </Link>
                </motion.div>

                {/* Info circle */}
                <motion.div whileTap={squishyTap} style={{ willChange: "transform" }}>
                <Link href={`/anime/${item.id}`}
                  className="tap-scale w-10 h-10 flex items-center justify-center rounded-full bg-white/10 border border-white/15
                    hover:bg-white/20 transition-colors"
                >
                  <Info className="w-4 h-4 text-white" />
                </Link>
                </motion.div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Dots */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-20">
        {items.slice(0, 8).map((_, i) => (
          <button key={i} onClick={() => goTo(i)}
            className={cn(
              "h-[3px] rounded-full transition-all duration-400",
              i === idx ? "w-6 bg-primary shadow-[0_0_6px_rgba(229,43,80,0.7)]" : "w-[6px] bg-white/25 hover:bg-white/50"
            )}
          />
        ))}
      </div>

      {/* Side Arrows — vertically centered */}
      <button
        onClick={() => goTo((idx - 1 + total) % total)}
        className="absolute left-3 top-1/2 -translate-y-1/2 z-20 group hidden sm:flex
          w-10 h-20 items-center justify-center
          rounded-r-2xl
          bg-gradient-to-r from-black/40 to-transparent
          hover:from-black/65 hover:to-black/10
         
          transition-all duration-200"
        aria-label="Previous"
      >
        <ChevronLeft className="w-5 h-5 text-white/50 group-hover:text-white transition-colors duration-200 -translate-x-0.5 group-hover:-translate-x-1 transition-transform" />
      </button>
      <button
        onClick={() => goTo((idx + 1) % total)}
        className="absolute right-3 top-1/2 -translate-y-1/2 z-20 group hidden sm:flex
          w-10 h-20 items-center justify-center
          rounded-l-2xl
          bg-gradient-to-l from-black/40 to-transparent
          hover:from-black/65 hover:to-black/10
         
          transition-all duration-200"
        aria-label="Next"
      >
        <ChevronRight className="w-5 h-5 text-white/50 group-hover:text-white transition-colors duration-200 translate-x-0.5 group-hover:translate-x-1 transition-transform" />
      </button>
    </div>
  );
}

// ── Upcoming Section ──────────────────────────────────────────────────────────
function UpcomingSection() {
  const { data, isLoading, isError } = useUpcoming();
  const [, setLocation] = useLocation();
  const items = data?.items ?? [];

  if (isError || (!isLoading && items.length === 0)) return null;

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      {/* Section header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <h2 className="font-display text-[0.95rem] font-bold text-white/90 flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400 fill-amber-400/60" />
          Upcoming
        </h2>
        <span className="text-[10px] font-medium text-white/30 uppercase tracking-wider">Coming Soon</span>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="w-10 h-14 shrink-0 shimmer rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 shimmer rounded-full w-3/4" />
                  <div className="h-2.5 shimmer rounded-full w-1/3" />
                </div>
              </div>
            ))
          : items.slice(0, 6).map((item, i) => (
              <button key={item.id} onClick={() => setLocation(`/anime/${item.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors text-left group"
              >
                {/* Rank */}
                <span className="w-5 text-center text-[11px] font-bold text-white/20 shrink-0 group-hover:text-primary/50 transition-colors">
                  {i + 1}
                </span>

                {/* Poster */}
                <div className="w-10 h-[56px] shrink-0 overflow-hidden rounded-lg bg-secondary border border-white/[0.07] relative">
                  <img src={item.posterUrl} alt={item.title}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>

                {/* Dot */}
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400/70 shrink-0" />

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[12px] text-white/80 group-hover:text-white transition-colors leading-snug line-clamp-2">
                    {item.title}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.type && (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-white/30">
                        {item.type === "MOVIE" || item.type === "Movie"
                          ? <Film className="w-2.5 h-2.5" />
                          : <Tv2 className="w-2.5 h-2.5" />}
                        {typeShort(item.type)}
                      </span>
                    )}
                    {item.year && (
                      <span className="text-[10px] font-medium text-white/25">{item.year}</span>
                    )}
                    {item.episodeCount && (
                      <span className="text-[10px] font-medium text-white/25">{item.episodeCount} eps</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
      </div>
    </section>
  );
}

// ── Continue Watching Section ─────────────────────────────────────────────────
// Shows recently watched anime in a video-player-style card (16:9 aspect
// ratio with poster background + play button overlay + episode number badge).
// Data comes from localStorage — no server storage.
function ContinueWatchingSection() {
  const entries = useContinueWatching();

  if (entries.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-heading font-display text-[1.05rem] font-bold text-white flex items-center gap-2">
          <History className="w-4 h-4 text-primary shrink-0" />
          Continue Watching
        </h2>
      </div>
      <div className="flex items-stretch gap-3 sm:gap-4 overflow-x-auto no-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
        {entries.map((entry, i) => (
          <Link
            key={`${entry.animeId}-${entry.episodeId}`}
            href={`/watch/${entry.animeId}/${entry.episodeId}?lang=${entry.lang}&provider=${entry.provider}`}
            className="group relative shrink-0 w-[240px] sm:w-[280px] block overflow-hidden rounded-xl border border-white/[0.06] hover:border-primary/30 transition-all bg-black"
          >
            {/* 16:9 aspect video-style card */}
            <div className="relative aspect-video overflow-hidden">
              {entry.posterUrl ? (
                <img
                  src={entry.posterUrl}
                  alt={entry.title}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="w-full h-full bg-white/[0.04] flex items-center justify-center">
                  <Tv2 className="w-8 h-8 text-white/20" />
                </div>
              )}

              {/* Gradient overlay for readability */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

              {/* Play button overlay */}
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-12 h-12 rounded-full bg-primary/90 flex items-center justify-center shadow-lg group-hover:bg-primary transition-colors"
                >
                  <Play className="w-4 h-4 fill-white text-white ml-0.5" />
                </motion.div>
              </div>

              {/* Episode number badge — top right */}
              <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/70 border border-white/10">
                <span className="text-[10px] font-black tabular-nums text-white">
                  EP {entry.episodeNumber}
                </span>
              </div>

              {/* Title + info at bottom */}
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <p className="font-bold text-sm leading-tight line-clamp-1 text-white">
                  {entry.title}
                </p>
                <p className="text-[11px] text-white/50 mt-0.5">
                  Episode {entry.episodeNumber}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────
const CARD_W = "w-[140px] sm:w-[158px] md:w-[168px]";

function HomeSkeleton() {
  return (
    <div className="flex flex-col w-full">
      <div className="w-full bg-[#08090f] shimmer" style={{ height: "clamp(420px,68vw,580px)" }} />
      <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-6 py-8 space-y-10">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-4">
            <div className="h-5 shimmer w-36 rounded-full" />
            {/* overflow-x-hidden prevents skeleton cards from reflow-shifting
                at different viewport sizes before real content arrives */}
            <div className="overflow-x-hidden">
              <div className="flex gap-3">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className={cn("shrink-0 space-y-2.5", CARD_W)}>
                    <div className="aspect-[2/3] shimmer rounded-xl" />
                    <div className="h-3 shimmer rounded-full w-3/4" />
                    <div className="h-2.5 shimmer rounded-full w-1/2" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────
export function Home() {
  const { data: homeData, isLoading } = useHomeSections();
  const sections = homeData?.sections ?? [];
  const bannerItems = homeData?.hero ?? [];

  if (isLoading) return <HomeSkeleton />;

  const topSections = sections.slice(0, 2);
  const browseAnime = sections
    .flatMap(s => s.items)
    .filter((item, idx, arr) => arr.findIndex(x => x.id === item.id) === idx)
    .slice(0, 9);

  return (
    <div className="flex flex-col w-full">

      {/* ── Hero ── */}
      {bannerItems.length > 0 && <HeroBanner items={bannerItems} />}

      {/* ── Main content ── */}
      <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-6 py-8 space-y-12">

        {/* ── Continue Watching (localStorage based, no server storage) ── */}
        <ContinueWatchingSection />

        {topSections.map((section, i) => {
          const meta = sectionMeta(section.title);
          return (
            <div key={`${section.title}-${i}`}>
              <RowSlider title={section.title} icon={meta ? { component: meta.icon, color: meta.color } : undefined}>
                {section.items.map((anime, j) => (
                  <AnimeCard key={anime.id} anime={anime} className={CARD_W} priority={i === 0 && j < 5} />
                ))}
              </RowSlider>
            </div>
          );
        })}

        {/* ── Upcoming ── */}
        <UpcomingSection />

        {/* ── Browse ── */}
        {browseAnime.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-heading font-display text-[1.05rem] font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />
                Browse
              </h2>
              <Link href="/search"
                className="text-[11px] font-medium text-white/35 hover:text-primary transition-colors flex items-center gap-1"
              >
                See all <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {browseAnime.map((anime, i) => (
                <AnimeCard key={anime.id} anime={anime} priority={i < 3} />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="mt-8 border-t border-white/[0.04] py-8 px-4">
        <div className="max-w-screen-xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-primary to-rose-700 flex items-center justify-center">
              <Tv2 className="w-3 h-3 text-white" />
            </div>
            <span className="font-display font-bold text-sm text-white/60">
              Ani<span className="text-gradient-red">Stream</span>
            </span>
          </div>
          <p className="text-[11px] text-white/20 font-medium text-center">
            © {new Date().getFullYear()} AniStream. Content sourced from AniList & third-party providers.
          </p>
          <div className="flex items-center gap-4">
            <Link href="/search" className="text-[11px] text-white/25 hover:text-white/55 transition-colors font-medium">Search</Link>
            <Link href="/schedule" className="text-[11px] text-white/25 hover:text-white/55 transition-colors font-medium">Schedule</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
