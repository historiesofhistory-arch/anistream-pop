import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, SlidersHorizontal, X, ChevronDown, Star, Tv2, Film } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import { apiUrl } from "../lib/api";
import { withClientHeader } from "../lib/custom-fetch";
import { motion, AnimatePresence } from "framer-motion";
import { staggerContainer, staggerChild } from "../lib/transitions";

// ── Types ──────────────────────────────────────────────────────────────────────
interface BrowseItem {
  id: number; title: string; posterUrl: string;
  type?: string | null; year?: number | null; rating?: number | null;
}
interface BrowseResult { items: BrowseItem[]; hasNextPage: boolean; total?: number; }

// ── Filter config ──────────────────────────────────────────────────────────────
const GENRES = ["Action","Adventure","Comedy","Drama","Ecchi","Fantasy","Horror","Mahou Shoujo","Mecha","Music","Mystery","Psychological","Romance","Sci-Fi","Slice of Life","Sports","Supernatural","Thriller"];
const YEARS = Array.from({ length: 35 }, (_, i) => String(new Date().getFullYear() - i));
const SEASONS = ["WINTER","SPRING","SUMMER","FALL"];
const FORMATS = [
  { value: "TV", label: "TV" }, { value: "MOVIE", label: "Movie" },
  { value: "OVA", label: "OVA" }, { value: "ONA", label: "ONA" },
  { value: "SPECIAL", label: "Special" },
];
const STATUSES = [
  { value: "RELEASING", label: "Airing" },
  { value: "FINISHED", label: "Finished" },
  { value: "NOT_YET_RELEASED", label: "Upcoming" },
];
const SORTS = [
  { value: "POPULARITY_DESC", label: "Popularity" },
  { value: "SCORE_DESC", label: "Top Rated" },
  { value: "TRENDING_DESC", label: "Trending" },
  { value: "UPDATED_AT_DESC", label: "Latest" },
  { value: "START_DATE_DESC", label: "Newest" },
];

interface Filters {
  search: string; genre: string; year: string;
  season: string; format: string; status: string; sort: string; page: number;
}
const DEFAULT: Filters = { search: "", genre: "", year: "", season: "", format: "", status: "", sort: "POPULARITY_DESC", page: 1 };

// ── Fetch ──────────────────────────────────────────────────────────────────────
function buildUrl(f: Filters) {
  const p = new URLSearchParams();
  if (f.search)  p.set("search", f.search);
  if (f.genre)   p.set("genre", f.genre);
  if (f.year)    p.set("year", f.year);
  if (f.season)  p.set("season", f.season);
  if (f.format)  p.set("format", f.format);
  if (f.status)  p.set("status", f.status);
  if (f.sort)    p.set("sort", f.sort);
  p.set("page", String(f.page));
  return apiUrl(`/api/browse?${p}`);
}

// ── Dropdown chip ──────────────────────────────────────────────────────────────
function FilterChip({
  label, value, options, onChange, allLabel = "All",
}: {
  label: string; value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void; allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = !!value;

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const display = value ? (options.find(o => o.value === value)?.label ?? value) : label;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          "tap-scale flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-all whitespace-nowrap",
          active
            ? "bg-primary/15 border-primary/40 text-white"
            : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white hover:border-white/20"
        )}
      >
        {display}
        {active
          ? <X className="w-3 h-3 ml-0.5" onClick={(e) => { e.stopPropagation(); onChange(""); setOpen(false); }} />
          : <ChevronDown className={cn("w-3 h-3 ml-0.5 transition-transform", open && "rotate-180")} />}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-40 w-44 max-h-60 overflow-y-auto rounded-xl border border-white/[0.09] bg-[#0d0d14] shadow-2xl no-scrollbar">
          <button
            onClick={() => { onChange(""); setOpen(false); }}
            className={cn("w-full text-left px-3 py-2.5 text-xs font-semibold hover:bg-white/[0.05] transition-colors",
              !value ? "text-primary" : "text-white/40")}
          >{allLabel}</button>
          {options.map(o => (
            <button key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn("w-full text-left px-3 py-2.5 text-xs font-semibold hover:bg-white/[0.05] transition-colors",
                value === o.value ? "text-primary" : "text-white/60")}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Browse Item Card ──────────────────────────────────────────────────────────
function BrowseCard({ item }: { item: BrowseItem }) {
  const [, setLocation] = useLocation();
  return (
    <motion.div variants={staggerChild}>
      <button
        onClick={() => setLocation(`/anime/${item.id}`)}
        className="tap-scale group text-left w-full flex flex-col gap-1.5"
      >
        <div className="w-full aspect-[2/3] overflow-hidden rounded-xl border border-white/[0.06] bg-secondary relative">
          <img
            src={item.posterUrl} alt={item.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {/* Rating badge — no backdrop-blur (user doesn't like glassy effects) */}
          {item.rating != null && (
            <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-black/80 px-1.5 py-0.5 rounded-lg border border-white/10">
              <Star className="w-2.5 h-2.5 fill-yellow-400 text-yellow-400" />
              <span className="text-[9px] font-bold text-white/90">{item.rating.toFixed(1)}</span>
            </div>
          )}
          {/* Hover play */}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <div className="w-9 h-9 rounded-full bg-primary/90 flex items-center justify-center">
              <svg className="w-4 h-4 fill-white translate-x-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-white/80 group-hover:text-white transition-colors leading-snug line-clamp-2">
            {item.title}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {item.type && (
              <span className="flex items-center gap-0.5 text-[10px] text-white/30">
                {item.type === "MOVIE" ? <Film className="w-2.5 h-2.5" /> : <Tv2 className="w-2.5 h-2.5" />}
                {item.type === "TV" ? "TV" : item.type === "MOVIE" ? "Movie" : item.type}
              </span>
            )}
            {item.year && <span className="text-[10px] text-white/25">{item.year}</span>}
          </div>
        </div>
      </button>
    </motion.div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function GridSkeleton({ count = 18 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="w-full aspect-[2/3] shimmer rounded-xl" />
          <div className="h-3 shimmer rounded-full w-3/4" />
          <div className="h-2.5 shimmer rounded-full w-1/3" />
        </div>
      ))}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function Browse() {
  const [filters, setFilters] = useState<Filters>(DEFAULT);
  const [inputVal, setInputVal] = useState("");
  const [allItems, setAllItems] = useState<BrowseItem[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback(<K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters(f => ({ ...f, [k]: v, page: 1 }));
    setAllItems([]);
  }, []);

  // Debounce search
  function handleSearchInput(v: string) {
    setInputVal(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters(f => ({ ...f, search: v, page: 1 }));
      setAllItems([]);
    }, 420);
  }

  function clearSearch() {
    setInputVal("");
    set("search", "");
  }

  const { data, isFetching } = useQuery<BrowseResult>({
    queryKey: ["browse", filters],
    queryFn: () => fetch(buildUrl(filters), { headers: withClientHeader() }).then(r => r.json()),
    staleTime: 3 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  // Accumulate pages
  useEffect(() => {
    if (!data?.items) return;
    if (filters.page === 1) {
      setAllItems(data.items);
    } else {
      setAllItems(prev => {
        const ids = new Set(prev.map(x => x.id));
        return [...prev, ...data.items.filter(x => !ids.has(x.id))];
      });
    }
  }, [data, filters.page]);

  function loadMore() {
    setFilters(f => ({ ...f, page: f.page + 1 }));
  }

  const hasActiveFilter = !!(filters.genre || filters.year || filters.season || filters.format || filters.status || filters.search);
  const showingLoading = isFetching && filters.page === 1;

  return (
    <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-5 py-5 space-y-4">

      {/* ── Search ── */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
        <input
          type="text"
          value={inputVal}
          onChange={e => handleSearchInput(e.target.value)}
          placeholder="Search anime..."
          className="w-full pl-10 pr-10 py-3 rounded-xl bg-white/[0.05] border border-white/[0.09] text-sm text-white/90
            placeholder:text-white/25 focus:outline-none focus:border-primary/50 focus:bg-white/[0.07] transition-all"
        />
        {inputVal && (
          <button onClick={clearSearch}
            className="tap-scale absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center
              rounded-full bg-white/10 hover:bg-white/20 text-white/50 hover:text-white transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Filters ── */}
      <div className="space-y-2.5">
        {/* Genre row — scrollable */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
          <div className="flex items-center gap-1 shrink-0 text-white/30">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="text-xs font-semibold">Genres</span>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {GENRES.map(g => (
              <button key={g}
                onClick={() => set("genre", filters.genre === g ? "" : g)}
                className={cn(
                  "tap-scale shrink-0 px-3 py-1.5 rounded-full text-[10px] font-semibold border transition-all whitespace-nowrap",
                  filters.genre === g
                    ? "bg-primary text-white border-primary shadow-[0_0_10px_rgba(229,43,80,0.35)]"
                    : "bg-white/[0.03] border-white/[0.08] text-white/45 hover:text-white hover:border-white/20"
                )}
              >{g}</button>
            ))}
          </div>
        </div>

        {/* Other filters row */}
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            label="Year" value={filters.year}
            options={YEARS.map(y => ({ value: y, label: y }))}
            onChange={v => set("year", v)}
          />
          <FilterChip
            label="Season" value={filters.season}
            options={SEASONS.map(s => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            onChange={v => set("season", v)}
          />
          <FilterChip
            label="Format" value={filters.format}
            options={FORMATS}
            onChange={v => set("format", v)}
          />
          <FilterChip
            label="Status" value={filters.status}
            options={STATUSES}
            onChange={v => set("status", v)}
          />
          <FilterChip
            label="Sort" value={filters.sort}
            options={SORTS}
            allLabel="Default"
            onChange={v => set("sort", v || "POPULARITY_DESC")}
          />

          {/* Clear all */}
          {hasActiveFilter && (
            <button
              onClick={() => { setFilters(DEFAULT); setInputVal(""); setAllItems([]); }}
              className="tap-scale flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold text-primary/70
                hover:text-primary border border-primary/20 hover:border-primary/40 transition-all"
            >
              <X className="w-3 h-3" />Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Result count ── */}
      {!showingLoading && allItems.length > 0 && (
        <p className="text-[11px] text-white/30 font-medium">
          Showing {allItems.length}{data?.hasNextPage ? "+" : ""} results
        </p>
      )}

      {/* ── Grid ── */}
      {/* Key changes when filters change so AnimatePresence remounts the grid
          and re-runs the stagger animation on every search/filter change.
          Without this key, Framer Motion only runs the stagger once on initial
          mount — subsequent searches don't animate. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`${filters.search}-${filters.genre}-${filters.year}-${filters.season}-${filters.format}-${filters.status}-${filters.sort}-${filters.page === 1 ? 'p1' : 'p2'}`}
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3"
        >
          {showingLoading
            ? <GridSkeleton count={18} />
            : allItems.map(item => <BrowseCard key={item.id} item={item} />)
          }
          {isFetching && filters.page > 1 && <GridSkeleton count={6} />}
        </motion.div>
      </AnimatePresence>

      {/* ── Empty ── */}
      {!isFetching && allItems.length === 0 && (
        <div className="py-20 flex flex-col items-center gap-3 text-center">
          <p className="text-3xl">🔍</p>
          <p className="text-white/40 text-sm font-medium">No anime found</p>
          <p className="text-white/20 text-xs">Try adjusting your filters</p>
        </div>
      )}

      {/* ── Load more ── */}
      {!isFetching && data?.hasNextPage && allItems.length > 0 && (
        <div className="flex justify-center pt-2 pb-6">
          <button
            onClick={loadMore}
            className="tap-scale px-8 py-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.09]
              text-sm font-semibold text-white/60 hover:text-white transition-all"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  );
}
