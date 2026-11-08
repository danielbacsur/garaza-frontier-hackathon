"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { WorkspaceMark } from "@/components/avatar";
import { apps, questions, users, workspace, type AppId } from "@/lib/data";
import { Caret, ChevronDown, Heatmaps, Overview, Questions, Record, Search, Users } from "./icons";

const views = [
  { href: "/", label: "Overview", icon: Overview },
  { href: "/users", label: "Users", icon: Users, count: users.length },
  { href: "/questions", label: "Questions", icon: Questions, count: questions.length },
  { href: "/heatmaps", label: "Heatmaps", icon: Heatmaps },
] as const;

/** How many questions each piece of software drew, most first. */
const appCounts = Object.entries(
  questions.reduce<Record<string, number>>((counts, q) => ({ ...counts, [q.app]: (counts[q.app] ?? 0) + q.asks }), {}),
).sort((a, b) => b[1] - a[1]) as [AppId, number][];

function Row({ href, icon, label, end, active }: { href: string; icon: ReactNode; label: string; end?: ReactNode; active?: boolean }) {
  return (
    <li>
      <Link
        href={href}
        className={`flex h-7 items-center gap-2 rounded-[6px] px-2 text-[13px] font-medium tracking-[-0.005em] transition-colors ${
          active ? "bg-black/[0.055] text-fg" : "text-fg-2 hover:bg-black/[0.03]"
        }`}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        {end ? <span className="ml-auto flex shrink-0 items-center pl-2">{end}</span> : null}
      </Link>
    </li>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex h-6 items-center gap-0.5 px-2 text-[12px] font-medium text-fg-4">
      {children}
      <Caret size={12} className="opacity-80" />
    </div>
  );
}

/** The sidebar: the workspace, the views, the software people ask about and the recordings. */
export function Sidebar({ recordings }: { recordings: { slug: string; title: string }[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex min-h-0 flex-col overflow-y-auto pt-1.5 pr-3 pl-1 max-md:hidden">
      <div className="flex h-8 items-center pl-1.5">
        <WorkspaceMark name={workspace} size={20} />
        <span className="ml-1.5 truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-fg">{workspace}</span>
        <ChevronDown size={12} className="ml-1 text-fg-4" />
        <span className="ml-auto flex size-7 items-center justify-center text-fg-3">
          <Search size={16} />
        </span>
      </div>

      <ul className="mt-3 flex flex-col gap-0.5">
        {views.map(({ href, label, icon: ViewIcon, ...rest }) => (
          <Row
            key={href}
            href={href}
            label={label}
            active={pathname === href}
            icon={<ViewIcon size={16} className="text-fg-3" />}
            end={
              "count" in rest ? (
                <span className="min-w-[18px] text-center text-[12px] font-normal text-fg-4 tabular-nums">{rest.count}</span>
              ) : null
            }
          />
        ))}
      </ul>

      <SectionLabel>Software</SectionLabel>
      <ul className="flex flex-col gap-0.5">
        {appCounts.map(([id, asks]) => (
          <Row
            key={id}
            href={`/questions?app=${id}`}
            label={apps[id].name}
            icon={
              <span className="flex size-4 items-center justify-center">
                <span className="size-2 rounded-full" style={{ background: apps[id].color }} />
              </span>
            }
            end={<span className="text-[12px] font-normal text-fg-4 tabular-nums">{asks}</span>}
          />
        ))}
      </ul>

      <SectionLabel>Recordings</SectionLabel>
      <ul className="flex flex-col gap-0.5">
        {recordings.length ? (
          recordings.map((rec) => (
            <Row
              key={rec.slug}
              href={`/heatmaps?r=${rec.slug}`}
              label={rec.title}
              icon={<Record size={16} className="text-[#e5484d]" />}
            />
          ))
        ) : (
          <li className="flex h-7 items-center px-2 text-[13px] text-fg-4">None yet</li>
        )}
      </ul>
    </nav>
  );
}
