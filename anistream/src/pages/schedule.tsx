import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import {
  Play,
  CheckCircle2,
  Radio,
  Calendar,
  Clock3,
} from "lucide-react";
import { cn } from "../lib/utils";
import { apiUrl } from "../lib/api";
import { withClientHeader } from "../lib/custom-fetch";
import { motion, AnimatePresence } from "framer-motion";

// ── Types ────────────────────────────────────────────────────────────────

interface ScheduleItem {
  id: number;
  title: string;
  posterUrl: string;
  episode: number | null;
  time: string | null;
  aired: boolean;
}

interface ScheduleDay {
  day: string;
  dayIndex: number;
  date: string; // "YYYY-MM-DD"
  items: ScheduleItem[];
}

interface ScheduleResponse {
  schedule: ScheduleDay[];
  weekStart: string;
  weekEnd: string;
  timezone: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_FULL = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
];

// Detect user timezone. Falls back to Asia/Kolkata.
const USER_TZ =
  (typeof Intl !== "undefined" &&
    Intl.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone) ||
  "Asia/Kolkata";

// ── Date helpers ─────────────────────────────────────────────────────────

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    timeZone: USER_TZ,
  }).format(new Date());
}

function dayOfMonth(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDate();
}

function monthShort(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", timeZone: "UTC",
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function formatWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sFmt = s.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const eFmt = e.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (s.getUTCMonth() === e.getUTCMonth()) {
    return `${sFmt.split(" ")[0]} ${s.getUTCDate()} – ${e.getUTCDate()}`;
  }
  return `${sFmt} – ${eFmt}`;
}

// Today's day index (0=Mon, 6=Sun) in the user's timezone.
function getTodayDayIndex(): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    weekday: "short", timeZone: USER_TZ,
  }).format(new Date());
  const idx = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
  return idx < 0 ? 0 : (idx + 6) % 7;
}

// ── Data hook ────────────────────────────────────────────────────────────

function useSchedule() {
  return useQuery<ScheduleResponse>({
    queryKey: ["anime-schedule"],
    queryFn: () =>
      fetch(
        apiUrl(`/api/anime/schedule?tz=${encodeURIComponent(USER_TZ)}`),
        { headers: withClientHeader() }
      ).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
}

// ── Sub-components ────────────────────────────────────────────────────────

// Day pill in the horizontal day selector
function DayPill({
  dayShort,
  date,
  isSelected,
  isToday,
  onSelect,
}: {
  dayShort: string;
  date: string;
  isSelected: boolean;
  isToday: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "relative flex flex-col items-center justify-center shrink-0",
        "min-w-[52px] sm:min-w-[68px] px-3 py-2.5 sm:py-3 rounded-xl transition-all",
        "border",
        isSelected
          ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/25"
          : "bg-white/[0.02] hover:bg-white/[0.05] text-foreground/70 border-white/[0.06]"
      )}
    >
      <span
        className={cn(
          "text-[10px] font-bold uppercase tracking-wider",
          isSelected ? "text-primary-foreground/90" : "text-foreground/50"
        )}
      >
        {dayShort}
      </span>
      <span
        className={cn(
          "text-base sm:text-lg font-black tabular-nums mt-0.5 leading-none",
          isToday && !isSelected && "text-emerald-400"
        )}
      >
        {date ? dayOfMonth(date) : "—"}
      </span>

      {/* Today indicator only — small dot, no count badge to avoid overlap */}
      {isToday && (
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
      )}
    </button>
  );
}

// A single episode card
function EpisodeCard({ item, index }: { item: ScheduleItem; index: number }) {
  const [, setLocation] = useLocation();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.04, 0.4), ease: "easeOut" }}
      onClick={() => setLocation(`/anime/${item.id}`)}
      className={cn(
        "group relative flex items-stretch gap-0 overflow-hidden rounded-xl cursor-pointer",
        "transition-all duration-200 hover:-translate-y-0.5",
        "border",
        item.aired
          ? "border-white/[0.05] bg-white/[0.015]"
          : "border-white/[0.08] bg-white/[0.03] hover:border-primary/30 hover:bg-white/[0.05]"
      )}
    >
      {/* Left accent bar — colored by airing status */}
      <div
        className={cn(
          "w-1 shrink-0",
          item.aired ? "bg-emerald-500/40" : "bg-primary"
        )}
      />

      {/* Poster */}
      <div className="relative shrink-0 w-[58px] sm:w-[72px] h-[78px] sm:h-[96px] overflow-hidden bg-white/[0.02]">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt={item.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            <Calendar className="w-5 h-5" />
          </div>
        )}
        {/* Episode number chip on poster */}
        {item.episode != null && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-1.5 py-1">
            <span className="text-[10px] font-black tabular-nums text-white">
              EP {item.episode}
            </span>
          </div>
        )}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0 flex items-center px-3 py-2 gap-2">
        <div className="flex-1 min-w-0">
          {/* Time + status row */}
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                "text-[11px] sm:text-xs font-bold tabular-nums leading-none",
                item.aired ? "text-white/40" : "text-white"
              )}
            >
              {item.time ?? "—"}
            </span>

            {/* Status badge */}
            {item.aired ? (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400/80 border border-emerald-500/15">
                <CheckCircle2 className="w-2.5 h-2.5" />
                Aired
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-primary/15 text-primary border border-primary/20">
                <Radio className="w-2.5 h-2.5 animate-pulse" />
                Upcoming
              </span>
            )}
          </div>

          {/* Title — properly truncated for long names */}
          <h3
            className={cn(
              "font-bold text-sm sm:text-[15px] leading-tight line-clamp-2 transition-colors",
              item.aired
                ? "text-white/60 group-hover:text-white/80"
                : "text-white/90 group-hover:text-primary"
            )}
            title={item.title}
          >
            {item.title}
          </h3>
        </div>

        {/* Play button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setLocation(`/watch/${item.id}`);
          }}
          aria-label={`Watch ${item.title}`}
          className={cn(
            "shrink-0 flex items-center justify-center rounded-lg transition-all",
            "w-9 h-9 sm:w-10 sm:h-10 active:scale-90",
            item.aired
              ? "bg-white/5 hover:bg-white/10 text-white/60"
              : "bg-primary/90 hover:bg-primary text-white shadow-lg shadow-primary/25 hover:scale-110"
          )}
        >
          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
        </button>
      </div>
    </motion.div>
  );
}

// Skeleton card during loading
function SkeletonCard() {
  return (
    <div className="flex items-stretch gap-0 overflow-hidden rounded-xl border border-white/[0.05] bg-white/[0.015]">
      <div className="w-1 bg-white/5" />
      <div className="w-[58px] sm:w-[72px] h-[78px] sm:h-[96px] bg-white/[0.02] shimmer" />
      <div className="flex-1 px-3 py-2.5">
        <div className="h-3 w-16 rounded bg-white/5 shimmer mb-1.5" />
        <div className="h-4 w-full rounded bg-white/5 shimmer mb-1" />
        <div className="h-3 w-2/3 rounded bg-white/5 shimmer" />
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export function Schedule() {
  const { data, isLoading } = useSchedule();

  const todayDayIdx = getTodayDayIndex();
  const todayDateStr = todayLocal();

  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(todayDayIdx);
  const [direction, setDirection] = useState(0);

  const schedule = data?.schedule ?? [];
  const selectedDay = schedule[selectedDayIdx];
  const selectedItems = selectedDay?.items ?? [];
  const totalThisWeek = schedule.reduce((sum, d) => sum + d.items.length, 0);

  return (
    <div className="flex flex-col min-h-full overflow-x-hidden">
      {/* ── Compact Header ── */}
      <motion.header
        className="px-4 sm:px-6 pt-5 sm:pt-7 pb-4 border-b border-white/[0.06]"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="max-w-screen-xl mx-auto">
          {/* Title row — single line, no week navigation */}
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h1 className="font-display text-2xl sm:text-3xl font-black tracking-tight leading-none whitespace-nowrap">
              Airing <span className="text-primary">Schedule</span>
            </h1>
            {data && (
              <span className="text-xs sm:text-sm font-bold text-white/70 tabular-nums whitespace-nowrap shrink-0">
                {formatWeekRange(data.weekStart, data.weekEnd)}
              </span>
            )}
          </div>

          {/* Subtitle row */}
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <Clock3 className="w-3 h-3 shrink-0" />
            <span className="whitespace-nowrap">{data?.timezone || USER_TZ}</span>
            {totalThisWeek > 0 && (
              <span className="text-white/30 whitespace-nowrap">
                · {totalThisWeek} episode{totalThisWeek === 1 ? "" : "s"} this week
              </span>
            )}
          </p>
        </div>
      </motion.header>

      {/* ── Day selector — horizontal scroll, fits viewport exactly ── */}
      <div className="sticky top-14 z-30 bg-background border-b border-white/[0.06]">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-3">
          {/* overflow-x-auto with NO negative margin — the parent already has
              px-4 / sm:px-6, so pills scroll within the safe content area and
              never cause horizontal page overflow. */}
          <div className="overflow-x-auto no-scrollbar">
            <div className="flex items-center gap-1.5 sm:gap-2 w-max">
              {(schedule.length > 0 ? schedule : Array.from({ length: 7 }).map((_, i) => ({
                day: DAYS_FULL[i], dayIndex: i, date: "", items: [],
              }))).map((day, idx) => (
                <DayPill
                  key={`${day.date || "placeholder"}-${idx}`}
                  dayShort={DAYS_SHORT[idx]}
                  date={day.date}
                  isSelected={idx === selectedDayIdx}
                  isToday={
                    (day.date && day.date === todayDateStr) ||
                    (idx === todayDayIdx)
                  }
                  onSelect={() => {
                    setDirection(idx > selectedDayIdx ? 1 : -1);
                    setSelectedDayIdx(idx);
                  }}
                />
              ))}
              {/* Trailing spacer so the last pill has breathing room */}
              <div className="w-1 shrink-0" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 max-w-screen-xl mx-auto w-full px-4 sm:px-6 py-5">
        {/* Day header */}
        <div className="flex items-baseline justify-between mb-3 sm:mb-4">
          <div className="flex items-baseline gap-2">
            <h2 className="font-display text-lg sm:text-xl font-black">
              {DAYS_FULL[selectedDayIdx]}
            </h2>
            {selectedDay?.date && (
              <span className="text-xs sm:text-sm text-muted-foreground tabular-nums">
                {monthShort(selectedDay.date)} {dayOfMonth(selectedDay.date)}
              </span>
            )}
          </div>
          <span className="text-[10px] sm:text-xs text-muted-foreground font-medium">
            {selectedItems.length === 0
              ? "No episodes"
              : `${selectedItems.length} episode${selectedItems.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* Items */}
        {isLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={selectedDayIdx}
              custom={direction}
              variants={{
                enter: (dir: number) => ({ opacity: 0, x: dir * 24 }),
                center: { opacity: 1, x: 0 },
                exit: (dir: number) => ({ opacity: 0, x: dir * -16 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="space-y-2 sm:space-y-2.5"
            >
              {selectedItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 sm:py-20 text-muted-foreground">
                  <Calendar className="w-10 h-10 mb-3 opacity-15" />
                  <p className="text-sm font-semibold mb-1">No episodes airing today</p>
                  <p className="text-xs text-muted-foreground/60 text-center max-w-xs">
                    Pick another day above
                  </p>
                </div>
              ) : (
                selectedItems.map((item, i) => (
                  <EpisodeCard
                    key={`${item.id}-${item.episode ?? "x"}-${i}`}
                    item={item}
                    index={i}
                  />
                ))
              )}
            </motion.div>
          </AnimatePresence>
        )}

        {/* Legend */}
        {!isLoading && selectedItems.length > 0 && (
          <motion.div
            className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-6 pt-4 border-t border-white/[0.05]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/60" />
              <span className="text-[10px] text-muted-foreground font-medium">Already aired</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-primary" />
              <span className="text-[10px] text-muted-foreground font-medium">Upcoming today</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock3 className="w-3.5 h-3.5 text-white/30" />
              <span className="text-[10px] text-muted-foreground font-medium">
                Times in {data?.timezone || USER_TZ}
              </span>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

