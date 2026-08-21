import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, ChevronLeft, Star, Calendar, ChevronDown, ChevronUp,
  Tv2, Film, Layers, Clock, Users, Bookmark, Share2, ExternalLink,
} from "lucide-react";
import { cn } from "../lib/utils";
import { apiUrl } from "../lib/api";
import { withClientHeader } from "../lib/custom-fetch";
import { squishyTap } from "../lib/transitions";

interface AnimeDetails {
  id: number; title: string; romaji: string | null; description: string;
  posterUrl: string; bannerUrl: string | null; genres: string[];
  type: string | null; year: number | null; status: string | null;
  episodeCount: number | null; rating: number | null; studio?: string | null;
  nextAiring?: { episode: number; airsAt: number } | null;
}
interface Season { id: number; title: string; isCurrent: boolean; posterUrl?: string | null; }

// ── Countdown Timer ──────────────────────────────────────────────────────────
// A proper capsule-style countdown timer with a LIVE ticking clock.
// Shows: EP number badge + live countdown in HH:MM:SS format (or with days).
// Updates EVERY SECOND — seconds visibly tick down (59, 58, 57...).
//
// Format:
//   > 24h: "Xd 12:34:56"
//   < 24h: "12:34:56"
//   <= 0:  "Airing now"
//
// The clock uses tabular-nums so digits don't shift width as they change.
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

function CountdownTimer({ airsAt, episode }: { airsAt: number; episode: number }) {
  const [remaining, setRemaining] = useState(() => airsAt - Date.now());
  useEffect(() => {
    const t = setInterval(() => setRemaining(airsAt - Date.now()), 1000);
    return () => clearInterval(t);
  }, [airsAt]);

  const text = formatCountdown(remaining);
  const isLive = remaining <= 0;

  return (
    <div className="inline-flex items-center gap-0 rounded-full border border-emerald-500/25 bg-emerald-500/8 overflow-hidden">
      {/* Episode number capsule */}
      <span className="flex items-center gap-1 px-3 py-1 bg-emerald-500/15 text-emerald-400 text-[11px] font-black uppercase tracking-wide">
        EP {episode}
      </span>
      {/* Divider */}
      <span className="w-px h-4 bg-emerald-500/20" />
      {/* Live countdown clock — always shows seconds, ticks every 1s */}
      <span className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-bold tabular-nums text-emerald-300">
        {/* Pulsing dot — indicates live countdown */}
        {!isLive && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
        {text}
      </span>
    </div>
  );
}

function useAnimeDetails(id: number) {
  return useQuery<AnimeDetails>({
    queryKey: ["anime-details", id],
    queryFn: () => fetch(apiUrl(`/api/anime/${id}/details`), { headers: withClientHeader() }).then(r => r.json()),
    enabled: !!id, staleTime: 15 * 60 * 1000, gcTime: 30 * 60 * 1000,
  });
}
function useAnimeSeasons(id: number) {
  return useQuery<{ seasons: Season[] }>({
    queryKey: ["anime-seasons", id],
    queryFn: () => fetch(apiUrl(`/api/anime/${id}/seasons`), { headers: withClientHeader() }).then(r => r.json()),
    enabled: !!id, staleTime: 20 * 60 * 1000,
  });
}

function statusBadge(status: string | null): { label: string; cls: string } {
  if (!status) return { label: "", cls: "" };
  const s = status.toUpperCase();
  if (s === "RELEASING" || s.includes("AIRING"))
    return { label: "Ongoing", cls: "bg-emerald-500/12 border-emerald-500/30 text-emerald-400" };
  if (s === "FINISHED")
    return { label: "Completed", cls: "bg-sky-500/12 border-sky-500/30 text-sky-400" };
  if (s === "NOT_YET_RELEASED")
    return { label: "Upcoming", cls: "bg-amber-500/12 border-amber-500/30 text-amber-400" };
  return { label: status, cls: "bg-white/6 border-white/12 text-white/50" };
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function DetailsSkeleton() {
  return (
    <div className="flex flex-col min-h-full pb-16">
      <div className="relative w-full overflow-hidden" style={{ minHeight: 340 }}>
        <div className="absolute inset-0 shimmer" />
        <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-background to-transparent" />
        <div className="relative z-10 flex flex-col items-center pt-14 pb-0 px-4">
          <div className="w-[148px] sm:w-[168px]">
            <div className="w-full aspect-[2/3] rounded-2xl shimmer" />
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center px-4 pt-5 gap-3">
        <div className="h-7 shimmer w-56 rounded-full" />
        <div className="flex gap-3">
          {[80, 44, 56].map(w => <div key={w} className={`h-4 shimmer rounded-full w-[${w}px]`} style={{width: w}} />)}
        </div>
      </div>
      <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-8 mt-5 space-y-4">
        <div className="flex gap-3">
          <div className="h-12 shimmer rounded-xl flex-1" />
          <div className="h-12 shimmer rounded-xl w-12" />
          <div className="h-12 shimmer rounded-xl w-12" />
          <div className="h-12 shimmer rounded-xl w-12" />
        </div>
        <div className="flex gap-2">{Array.from({length:5}).map((_,i)=><div key={i} className="h-7 shimmer rounded-full w-16"/>)}</div>
        <div className="space-y-2">{[1,.75,.5].map((w,i)=><div key={i} className="h-3 shimmer rounded-full" style={{width:`${w*100}%`}}/>)}</div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function Details() {
  const { animeId } = useParams<{ animeId: string }>();
  const id = Number(animeId);
  const [, setLocation] = useLocation();
  const [expandDesc, setExpandDesc] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [bgLoaded, setBgLoaded] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);

  const { data: details, isLoading } = useAnimeDetails(id);
  const { data: seasonsData } = useAnimeSeasons(id);

  const seasons = seasonsData?.seasons ?? [];
  const poster = details?.posterUrl ?? `https://img.anili.st/media/${id}`;
  const bg = details?.bannerUrl ?? poster;
  const title = details?.title ?? "";
  const { label: stLabel, cls: stCls } = statusBadge(details?.status ?? null);
  const isNotYetReleased = details?.status === "NOT_YET_RELEASED";

  if (isLoading) return <DetailsSkeleton />;

  function share() {
    if (navigator.share) {
      navigator.share({ title, url: window.location.href }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(window.location.href).catch(() => {});
    }
  }

  return (
    <div className="flex flex-col min-h-full pb-16">

      {/* ── Hero ── */}
      <div className="relative w-full overflow-hidden" style={{ minHeight: 340 }}>
        {/* Fallback bg */}
        <div className="absolute inset-0 bg-[#08090f]" />

        {/* Blurred bg image */}
        <img src={bg} alt="" aria-hidden loading="eager" fetchPriority="high"
          onLoad={() => setBgLoaded(true)}
          className={cn(
            "absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-500",
            bgLoaded ? "opacity-100" : "opacity-0"
          )}
          style={{ filter: "blur(32px) brightness(0.22) saturate(1.6)", transform: "scale(1.12)" }}
        />

        {/* Gradients */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-black/10 to-background" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />

        {/* Back */}
        <button onClick={() => history.back()}
          className="absolute top-4 left-4 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-xl
            bg-black/40 text-sm font-medium text-white/75 hover:text-white
            border border-white/10 hover:border-white/22 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />Back
        </button>

        {/* Centered poster — AniList-style entrance with glow */}
        <div className="relative z-10 flex justify-center pt-14 pb-0 px-4">
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 22, mass: 0.9 }}
            className="w-[148px] sm:w-[168px]"
          >
            <div className="w-full aspect-[2/3] overflow-hidden rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.8)] border border-white/10 relative">
              {!posterLoaded && <div className="absolute inset-0 shimmer rounded-2xl" />}
              <img src={poster} alt={title} loading="eager" fetchPriority="high"
                onLoad={() => setPosterLoaded(true)}
                className={cn(
                  "w-full h-full object-cover rounded-2xl transition-opacity duration-500",
                  posterLoaded ? "opacity-100" : "opacity-0"
                )}
              />
              {/* Subtle red glow behind poster — AniList-style */}
              <div
                aria-hidden
                className="absolute -inset-4 -z-10 rounded-3xl opacity-50 blur-2xl pointer-events-none"
                style={{ background: "radial-gradient(ellipse at center, rgba(229,43,80,0.30), transparent 65%)" }}
              />
            </div>
          </motion.div>
        </div>
      </div>

      {/* ── Info block ── */}
      <div className="flex flex-col items-center px-4 pt-5 pb-1 text-center gap-3">
        {/* Title — AniList-style logo entrance.
            The anime's title appears as a stylized "logo" with a bouncy
            spring entrance: fade + scale + slight y-offset, plus a glow
            that pulses once. Mirrors the feel of anime sites where each
            show's title is presented as a hero logo. */}
        <motion.h1
          initial={{ opacity: 0, y: 14, scale: 0.96, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          transition={{
            type: "spring", stiffness: 280, damping: 22, mass: 0.8,
            delay: 0.1,
          }}
          className="font-display font-black text-white leading-tight max-w-screen-sm tracking-tight"
          style={{
            fontSize: "clamp(1.25rem, 5.5vw, 2.05rem)",
            textShadow: "0 4px 24px rgba(0,0,0,0.5), 0 0 32px rgba(229,43,80,0.18)",
          }}
        >
          {title}
        </motion.h1>

        {/* Subtle accent line under the title — AniList-style */}
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "60px", opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent rounded-full"
          style={{ boxShadow: "0 0 8px rgba(229,43,80,0.6)" }}
        />

        {/* Meta row */}
        {details && (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-white/55">
            {details.rating != null && (
              <span className="flex items-center gap-1 font-semibold text-amber-400">
                <Star className="w-3.5 h-3.5 fill-current" />
                {Math.round(details.rating * 10)}%
              </span>
            )}
            {details.type && (
              <span className="flex items-center gap-1">
                {details.type === "Movie" || details.type === "MOVIE"
                  ? <Film className="w-3.5 h-3.5" />
                  : <Tv2 className="w-3.5 h-3.5" />}
                {details.type}
              </span>
            )}
            {details.episodeCount != null && (
              <span className="flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" />{details.episodeCount} eps
              </span>
            )}
            {details.type === "TV" && (
              <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />24m</span>
            )}
          </div>
        )}

        {/* Status / year / studio pills */}
        {details && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {stLabel && (
              <span className={cn("px-3 py-1 text-[11px] font-medium border rounded-full", stCls)}>
                {stLabel}
              </span>
            )}
            {details.year && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-white/40 border border-white/10 px-3 py-1 rounded-full">
                <Calendar className="w-3 h-3" />{details.year}
              </span>
            )}
            {details.studio && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-white/40 border border-white/10 px-3 py-1 rounded-full">
                <Users className="w-3 h-3" />{details.studio}
              </span>
            )}
          </div>
        )}

        {/* ── Next Episode Countdown Timer ── */}
        {details?.nextAiring && (
          <div className="flex justify-center mt-3">
            <CountdownTimer
              airsAt={details.nextAiring.airsAt}
              episode={details.nextAiring.episode}
            />
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-8 mt-4 space-y-5">

        {/* ── CTA Row: Watch Now + action icons ── */}
        <div className="flex items-stretch gap-2.5">
          {isNotYetReleased ? (
            <div className="flex-1 flex items-center justify-center gap-2 px-5 py-3.5 bg-white/5 border border-white/10 text-white/30 font-medium text-sm rounded-xl cursor-default">
              <Calendar className="w-4 h-4" />Coming Soon
            </div>
          ) : (
            <motion.button
              onClick={() => setLocation(`/watch/${id}`)}
              whileTap={squishyTap}
              whileHover={{ scale: 1.015, transition: { type: "spring", stiffness: 400, damping: 22, mass: 0.6 } }}
              style={{ willChange: "transform" }}
              className="flex-1 flex items-center justify-center gap-2.5 px-5 py-3.5 bg-primary hover:bg-primary/90
                text-white font-bold text-sm rounded-xl transition-colors
                shadow-[0_0_24px_rgba(229,43,80,0.3)] hover:shadow-[0_0_36px_rgba(229,43,80,0.45)]"
            >
              <Play className="w-4 h-4 fill-current" />Watch Now
            </motion.button>
          )}

          {/* Bookmark */}
          <motion.button onClick={() => setBookmarked(v => !v)}
            whileTap={squishyTap}
            style={{ willChange: "transform" }}
            title={bookmarked ? "Remove from watchlist" : "Add to watchlist"}
            className={cn(
              "w-12 flex items-center justify-center rounded-xl border transition-colors",
              bookmarked
                ? "bg-primary/15 border-primary/40 text-primary"
                : "bg-white/[0.04] border-white/[0.08] text-white/45 hover:bg-white/[0.08] hover:text-white/75"
            )}
          >
            <Bookmark className={cn("w-4 h-4", bookmarked && "fill-current")} />
          </motion.button>

          {/* Share */}
          <motion.button onClick={share}
            whileTap={squishyTap}
            style={{ willChange: "transform" }}
            title="Share"
            className="w-12 flex items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-white/45 hover:bg-white/[0.08] hover:text-white/75 transition-colors"
          >
            <Share2 className="w-4 h-4" />
          </motion.button>

          {/* AniList link */}
          <motion.a href={`https://anilist.co/anime/${id}`} target="_blank" rel="noopener noreferrer"
            whileTap={squishyTap}
            style={{ willChange: "transform" }}
            title="View on AniList"
            className="w-12 flex items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-white/45 hover:bg-white/[0.08] hover:text-white/75 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
          </motion.a>
        </div>

        {/* Genres */}
        {details?.genres?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {details.genres.slice(0, 8).map(g => (
              <span key={g}
                className="px-3 py-1.5 border border-white/[0.08] text-white/45 text-[10px] font-medium
                  hover:border-primary/35 hover:text-white/70 transition-colors cursor-default rounded-full"
              >{g}</span>
            ))}
          </div>
        ) : null}

        {/* Synopsis */}
        {details?.description && (
          <div className="border-l-2 border-primary/35 pl-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-primary/60 mb-2">Synopsis</p>
            <p className={cn("text-sm text-white/60 leading-relaxed", !expandDesc && "line-clamp-3")}>
              {details.description}
            </p>
            {details.description.length > 200 && (
              <button onClick={() => setExpandDesc(v => !v)}
                className="flex items-center gap-1 text-primary/65 hover:text-primary text-xs font-medium mt-2 transition-colors"
              >
                {expandDesc
                  ? <><ChevronUp className="w-3.5 h-3.5" />Show less</>
                  : <><ChevronDown className="w-3.5 h-3.5" />Read more</>}
              </button>
            )}
          </div>
        )}

        {/* Info grid */}
        {details && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: "Type",   value: details.type },
              { label: "Year",   value: details.year?.toString() },
              { label: "Status", value: stLabel || details.status },
              { label: "Rating", value: details.rating ? `${details.rating.toFixed(1)} / 10` : null },
            ].filter(d => d.value).map(({ label, value }) => (
              <div key={label} className="p-3 border border-white/[0.06] bg-white/[0.02] rounded-xl">
                <p className="text-[9px] font-bold uppercase tracking-widest text-white/30 mb-1">{label}</p>
                <p className="text-xs font-medium text-white/80">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Seasons */}
        {seasons.length > 1 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-white/75">Seasons</span>
              <span className="text-xs text-white/30">{seasons.length} entries</span>
            </div>
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-3 -mx-1 px-1">
              {seasons.map((s, idx) => {
                const sPoster = s.posterUrl ?? `https://img.anili.st/media/${s.id}`;
                return (
                  <button key={s.id} onClick={() => setLocation(`/anime/${s.id}`)}
                    className={cn(
                      "shrink-0 group text-left relative rounded-xl overflow-hidden w-[88px] sm:w-[96px] transition-all",
                      s.isCurrent ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
                    )}
                  >
                    <div className="w-full aspect-[2/3] overflow-hidden rounded-xl border border-white/[0.08]">
                      <img src={sPoster} alt={s.title}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </div>
                    <div className={cn(
                      "absolute top-1.5 left-1.5 w-5 h-5 rounded-lg flex items-center justify-center text-[9px] font-bold",
                      s.isCurrent ? "bg-primary text-white" : "bg-black/65 text-white/65"
                    )}>{idx + 1}</div>
                    {s.isCurrent && (
                      <div className="absolute top-1.5 right-1.5 px-1 py-px bg-emerald-500 text-white text-[7px] font-bold uppercase tracking-wide rounded-md">
                        NOW
                      </div>
                    )}
                    <p className={cn(
                      "mt-1.5 text-[9px] font-medium line-clamp-2 leading-tight px-0.5",
                      s.isCurrent ? "text-white" : "text-white/45 group-hover:text-white/70"
                    )}>{s.title}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
