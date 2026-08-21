import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useRef, useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AnimeCard } from "../components/anime-card";
import {
  Loader2, Search as SearchIcon, X, Sparkles, TrendingUp, Clock,
} from "lucide-react";
import { cn } from "../lib/utils";
import { apiUrl } from "../lib/api";
import { withClientHeader } from "../lib/custom-fetch";
import {
  squishyTap, squishyHover, staggerContainer, staggerChild,
} from "../lib/transitions";

export function Search() {
  const [, setLocation] = useLocation();
  const rawQuery = new URLSearchParams(window.location.search).get("q") || "";
  const [input, setInput] = useState(rawQuery);
  // `searchQuery` is what actually drives the API call — debounced from `input`
  const [searchQuery, setSearchQuery] = useState(rawQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPushedQuery = useRef(rawQuery);

  // Sync input when navigating back/forward (URL changes externally)
  useEffect(() => {
    if (rawQuery !== lastPushedQuery.current) {
      lastPushedQuery.current = rawQuery;
      setInput(rawQuery);
      setSearchQuery(rawQuery);
    }
  }, [rawQuery]);

  // Focus WITHOUT scrolling — prevents the "screen jumps when search page mounts"
  // glitch on mobile. preventScroll is a standard DOM arg supported by all
  // modern browsers.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Fast debounce → drives actual search (220 ms feels instant)
  useEffect(() => {
    const q = input.trim();
    const timer = setTimeout(() => setSearchQuery(q), 220);
    return () => clearTimeout(timer);
  }, [input]);

  // Slower debounce → keeps URL shareable / browser history clean.
  // Uses `replace: true` so typing doesn't pollute back/forward history.
  useEffect(() => {
    const q = input.trim();
    const timer = setTimeout(() => {
      if (q.length >= 3 && q !== lastPushedQuery.current) {
        lastPushedQuery.current = q;
        setLocation(`/search?q=${encodeURIComponent(q)}`, { replace: true });
      } else if (q.length === 0 && lastPushedQuery.current) {
        lastPushedQuery.current = "";
        setLocation("/search", { replace: true });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [input]);

  const { data: searchResults, isLoading, isError } = useQuery<{ results: { id: number; title: string; posterUrl: string; type?: string | null; year?: number | null; rating?: number | null }[] }>({
    queryKey: ["anime-search", searchQuery],
    queryFn: () => fetch(apiUrl(`/api/anime/search?q=${encodeURIComponent(searchQuery)}`), { headers: withClientHeader() }).then(r => r.json()),
    enabled: searchQuery.length >= 3,
    staleTime: 5 * 60 * 1000,
  });

  const { data: trendingData } = useQuery<{ results: { id: number; title: string; posterUrl: string; type?: string | null; year?: number | null }[] }>({
    queryKey: ["anime-trending-for-search"],
    queryFn: () => fetch(apiUrl(`/api/home`), { headers: withClientHeader() }).then(r => r.json()).then(d => {
      // Flatten the first 2 home sections as "trending" suggestions
      const sections = d?.sections ?? [];
      const flat: any[] = [];
      for (const s of sections.slice(0, 2)) {
        for (const item of (s.items ?? [])) {
          flat.push(item);
          if (flat.length >= 12) break;
        }
        if (flat.length >= 12) break;
      }
      return { results: flat };
    }),
    staleTime: 15 * 60 * 1000,
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const q = input.trim();
      if (q.length >= 3) {
        if (q !== lastPushedQuery.current) {
          lastPushedQuery.current = q;
          // Use replace to avoid duplicate history entries when typing then Enter
          setLocation(`/search?q=${encodeURIComponent(q)}`, { replace: true });
        }
      }
    }
  };

  const results = searchResults?.results ?? [];
  const trending = trendingData?.results ?? [];
  const hasQuery = input.trim().length >= 3;

  // Suggestion chips — show when input is empty.
  // Kept short on purpose so they never wrap or get cut off on narrow mobile
  // screens. Longer titles (e.g. "Jujutsu Kaisen") were getting clipped on
  // small viewports — replaced with compact, equally recognizable labels.
  const suggestions = useMemo(() => [
    "Naruto", "Bleach", "One Piece", "Demon Slayer",
    "Chainsaw Man", "Spy x Family", "Attack on Titan", "Jujutsu Kaisen",
  ], []);

  return (
    <div className="flex flex-col min-h-full">
      {/* ── Hero search bar ── */}
      <div className="relative overflow-hidden border-b border-white/[0.06] bg-gradient-to-b from-white/[0.02] to-transparent">
        {/* Decorative background grid */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(rgba(229,43,80,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(229,43,80,0.10) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, #000 0%, transparent 70%)",
            WebkitMaskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, #000 0%, transparent 70%)",
          }}
        />

        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-10 pb-7">
          {/* Title */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="text-center mb-5"
          >
            <h1 className="font-display font-black text-3xl sm:text-4xl tracking-tight">
              Find your next{" "}
              <span className="text-gradient-red">anime</span>
            </h1>
            <p className="text-muted-foreground/70 text-sm mt-1.5">
              Search across thousands of titles — results appear as you type
            </p>
          </motion.div>

          {/* Search input — large, premium feel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.985, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28, delay: 0.05 }}
            className="relative"
          >
            <div className="absolute -inset-0.5 bg-gradient-to-r from-primary/30 via-rose-500/20 to-primary/30 rounded-2xl opacity-50 blur-md group-focus-within:opacity-80 transition-opacity" />
            <div className="relative flex items-center bg-[#0c0d14] border border-white/[0.1] rounded-2xl overflow-hidden group focus-within:border-primary/40 transition-colors">
              <SearchIcon className="absolute left-5 w-5 h-5 text-muted-foreground/70 pointer-events-none z-10" />
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search anime…"
                className="w-full bg-transparent py-4 sm:py-5 pl-14 pr-14 text-base sm:text-lg font-medium outline-none placeholder:text-muted-foreground/40"
              />
              {input && (
                <motion.button
                  type="button"
                  whileTap={squishyTap}
                  onClick={() => {
                    setInput("");
                    setSearchQuery("");
                    if (lastPushedQuery.current) {
                      lastPushedQuery.current = "";
                      setLocation("/search", { replace: true });
                    }
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </motion.button>
              )}
            </div>
          </motion.div>

          {/* Suggestion chips — only when input is empty */}
          <AnimatePresence>
            {!hasQuery && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className="flex flex-wrap gap-2 justify-center mt-5"
              >
                {suggestions.map((s, i) => (
                  <motion.button
                    key={s}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 + i * 0.025 }}
                    whileTap={squishyTap}
                    whileHover={squishyHover}
                    onClick={() => {
                      setInput(s);
                      lastPushedQuery.current = s;
                      setLocation(`/search?q=${encodeURIComponent(s)}`, { replace: true });
                    }}
                    // whitespace-nowrap ensures chip text never breaks across
                    // lines on narrow viewports. Smaller text + tighter padding
                    // on mobile prevents overflow when many chips are visible.
                    className="px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-white/65 hover:text-white bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.06] hover:border-primary/30 rounded-full whitespace-nowrap transition-colors"
                  >
                    {s}
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Results body ── */}
      <div className="max-w-screen-2xl mx-auto w-full px-4 sm:px-6 py-7 flex-1">

        {/* Results count header */}
        <AnimatePresence mode="wait">
          {hasQuery && !isLoading && searchQuery.length >= 3 && (
            <motion.div
              key={`count-${searchQuery}`}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
              className="mb-5 flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-1 h-6 bg-primary rounded-full shadow-[0_0_10px_rgba(220,38,38,0.5)]" />
                <h2 className="font-display text-lg font-bold">
                  {results.length > 0
                    ? <>{results.length} <span className="text-muted-foreground font-medium">results for</span> "{searchQuery}"</>
                    : <>No results for <span className="text-muted-foreground font-medium">"{searchQuery}"</span></>}
                </h2>
              </div>
              {results.length > 0 && (
                <span className="hidden sm:flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground/60 uppercase tracking-widest">
                  <Sparkles className="w-3 h-3" />
                  Instant results
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* States */}
        <AnimatePresence mode="wait">
          {/* Empty state (no query) — show trending */}
          {!hasQuery ? (
            <motion.div
              key="empty-trending"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              {trending.length > 0 && (
                <>
                  <div className="flex items-center gap-2.5 mb-4">
                    <TrendingUp className="w-5 h-5 text-orange-400" />
                    <h3 className="font-display text-lg font-bold">Trending now</h3>
                    <span className="text-[11px] text-muted-foreground/50 font-semibold">Pick one to get started</span>
                  </div>
                  <motion.div
                    variants={staggerContainer}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 md:gap-4"
                  >
                    {trending.map((anime) => (
                      <motion.div key={anime.id} variants={staggerChild}>
                        <AnimeCard anime={anime} />
                      </motion.div>
                    ))}
                  </motion.div>
                </>
              )}
              {trending.length === 0 && (
                <div className="flex flex-col items-center justify-center py-32 gap-6 text-muted-foreground">
                  <div className="w-20 h-20 bg-white/[0.04] border border-white/[0.07] flex items-center justify-center rounded-2xl">
                    <SearchIcon className="w-10 h-10 opacity-30" />
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-foreground/60 mb-1">Search for anime</p>
                    <p className="text-sm">Type at least 3 characters — results appear instantly</p>
                  </div>
                </div>
              )}
            </motion.div>
          ) : isLoading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 md:gap-4"
            >
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <div className="aspect-[2/3] shimmer rounded-xl" />
                  <div className="h-3 shimmer w-3/4 rounded-sm" />
                  <div className="h-2.5 shimmer w-1/2 rounded-sm" />
                </div>
              ))}
            </motion.div>
          ) : isError ? (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-24 gap-4 text-center"
            >
              <div className="w-16 h-16 bg-destructive/10 border border-destructive/20 flex items-center justify-center rounded-2xl">
                <Loader2 className="w-8 h-8 text-destructive" />
              </div>
              <div>
                <p className="font-semibold text-foreground mb-1">Search failed</p>
                <p className="text-sm text-muted-foreground">The upstream search is temporarily unavailable. Try again shortly.</p>
              </div>
            </motion.div>
          ) : results.length > 0 ? (
            // PERF: removed staggerContainer/staggerChild wrappers from the
            // search results grid. With 20 results, the stagger was delaying
            // each card by 0.04s — last card didn't start animating until
            // 800ms after the first, and 20 simultaneous spring animations
            // caused the "post-slide lag" the user reported.
            //
            // Cards now mount instantly (no entrance animation) — the
            // individual AnimeCard components still animate hover/tap springs.
            // Visually identical to before, but no jank after page transition.
            //
            // Also: each card wrapper has content-visibility:auto so offscreen
            // cards skip rendering entirely (huge win for 20-card grids).
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 md:gap-4"
            >
              {results.map((anime) => (
                <div
                  key={anime.id}
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: "260px",
                  }}
                >
                  <AnimeCard anime={anime} />
                </div>
              ))}
            </motion.div>
          ) : searchQuery.length >= 3 ? (
            <motion.div
              key="no-results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-32 gap-5 text-center"
            >
              <motion.div
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 22 }}
                className="w-24 h-24 bg-white/[0.03] border border-white/[0.06] flex items-center justify-center rounded-2xl"
              >
                <SearchIcon className="w-12 h-12 opacity-25" />
              </motion.div>
              <div>
                <p className="text-xl font-display font-semibold mb-2">No results found</p>
                <p className="text-muted-foreground text-sm max-w-sm mx-auto">
                  We couldn't find anything matching "{searchQuery}". Try a different spelling or a more general term.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center mt-2 max-w-md">
                {suggestions.slice(0, 4).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput(s);
                      lastPushedQuery.current = s;
                      setLocation(`/search?q=${encodeURIComponent(s)}`, { replace: true });
                    }}
                    className="px-3 py-1.5 text-xs font-semibold text-white/65 hover:text-white bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.06] hover:border-primary/30 rounded-full transition-colors"
                  >
                    Try: {s}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
