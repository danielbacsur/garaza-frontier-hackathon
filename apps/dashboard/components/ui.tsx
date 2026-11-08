import type { CSSProperties, ReactNode } from "react";
import { PersonAvatar } from "@/components/avatar";
import { apps, userById, type AppId } from "@/lib/data";

/** Entrance delays: each block of a view rises a little after the one above it. */
export const rise = (i: number): CSSProperties => ({ animationDelay: `${60 + i * 50}ms` });

/** The pane's top bar: the view's name on the left, quiet context on the right. */
export function TopBar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="hairline-b flex h-11 shrink-0 items-center justify-between px-5 text-[13px]">
      <h1 className="font-medium text-fg">{title}</h1>
      <div className="flex items-center gap-4 text-fg-4 tabular-nums">{children}</div>
    </header>
  );
}

/** A scrolling view body, its content in one centred column. */
export function Body({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto px-5 pt-8 pb-16 ${wide ? "max-w-[1120px]" : "max-w-[880px]"}`}>{children}</div>
    </div>
  );
}

export function Heading({ title, lead, at }: { title: string; lead?: string; at: number }) {
  return (
    <div className="rise" style={rise(at)}>
      <h2 className="text-[20px] leading-7 font-semibold tracking-[-0.016em] text-fg [font-variation-settings:'opsz'_20]">
        {title}
      </h2>
      {lead ? <p className="mt-1 max-w-[620px] text-[14px] leading-6 text-fg-3">{lead}</p> : null}
    </div>
  );
}

export function SectionTitle({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{children}</h3>
      {end}
    </div>
  );
}

/** A round chip naming a piece of software, led by its colour dot. */
export function AppChip({ app }: { app: AppId }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-fg-2 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.09)]">
      <span className="size-1.5 rounded-full" style={{ background: apps[app].color }} />
      {apps[app].name}
    </span>
  );
}

/** Seven small bars, Monday to Sunday, scaled to the tallest day across everyone. */
export function WeekBars({ week, max }: { week: number[]; max: number }) {
  return (
    <span className="flex h-5 items-end gap-[3px]" aria-label={`${week.join(", ")} questions over the week`}>
      {week.map((n, i) => (
        <span
          key={i}
          className={`w-[5px] rounded-[1.5px] ${n ? "bg-accent/70" : "bg-black/[0.07]"}`}
          style={{ height: `${Math.max(12, (n / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** A change against last week: green up, muted down, a dash for none. */
export function Trend({ value }: { value: number }) {
  if (value === 0) return <span className="text-fg-4">—</span>;
  return (
    <span className={value > 0 ? "text-green" : "text-fg-4"}>
      {value > 0 ? "↑" : "↓"} {Math.abs(value)}%
    </span>
  );
}

/** Overlapping avatars of the people who asked, at most four. */
export function AvatarStack({ ids }: { ids: string[] }) {
  return (
    <span className="flex -space-x-1">
      {ids.slice(0, 4).map((id) => (
        <PersonAvatar key={id} name={userById(id).name} size={22} ring />
      ))}
    </span>
  );
}

/** One number with its label, for the overview's row of stats. */
export function Stat({ label, value, note, at }: { label: string; value: ReactNode; note?: ReactNode; at: number }) {
  return (
    <div className="card rise px-4 py-3" style={rise(at)}>
      <div className="text-[12px] font-medium text-fg-4">{label}</div>
      <div className="mt-1 text-[24px] leading-8 font-semibold tracking-[-0.02em] text-fg tabular-nums">{value}</div>
      {note ? <div className="mt-0.5 text-[12px] text-fg-4">{note}</div> : null}
    </div>
  );
}
