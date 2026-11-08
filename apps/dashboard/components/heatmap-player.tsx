import type { ReactNode } from "react";
import type { Recording } from "@/lib/recordings";
import { minutes } from "@/lib/recordings";
import { Click, Done, Heatmaps, Record, Schedules, Skills, Todo, Travel, Workflows } from "./icons";

/** The recorded screen with the heatmap building up over it, as a looping GIF. */
export function HeatmapGif({ recording, className = "" }: { recording: Recording; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an animated GIF, served as is
    <img
      src={recording.gif}
      alt={`Cursor heatmap of “${recording.title}” in ${recording.app}`}
      width={recording.width}
      height={recording.height}
      className={`block h-auto w-full ${className}`}
    />
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid h-8 grid-cols-[104px_minmax(0,1fr)] items-center text-[13px]">
      <dt className="truncate text-fg-4">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 font-medium text-fg-2">{children}</dd>
    </div>
  );
}

/**
 * The pitch in four steps: watch how people really work, see it as a heatmap, turn it into a
 * workflow embedding, and write that out as a SKILL.md the second cursor can follow. Only the first
 * two run today.
 */
const pipeline = [
  { label: "Recorded", note: "Screen, cursor and clicks", icon: Record, done: true },
  { label: "Heatmap", note: "Where attention and clicks went", icon: Heatmaps, done: true },
  { label: "Workflow embedding", note: "Steps matched across people", icon: Workflows, done: false },
  { label: "SKILL.md", note: "A skill the second cursor follows", icon: Skills, done: false },
];

/** The recording's properties and where it is in the pipeline, in a side panel. */
export function RecordingPanel({ recording }: { recording: Recording }) {
  const recordedAt = new Date(recording.recordedAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <aside className="px-5 pt-5">
      <dl>
        <Property label="Software">{recording.app}</Property>
        <Property label="Recorded by">{recording.recordedBy}</Property>
        <Property label="Recorded">{recordedAt}</Property>
      </dl>

      <div className="my-3 h-px bg-black/[0.06]" />

      <dl>
        <Property label="Duration">
          <Schedules size={14} className="text-fg-4" />
          <span className="tabular-nums">{minutes(recording.durationSec)}</span>
        </Property>
        <Property label="Clicks">
          <Click size={14} className="text-fg-4" />
          <span className="tabular-nums">{recording.clicks}</span>
        </Property>
        <Property label="Cursor travel">
          <Travel size={14} className="text-fg-4" />
          <span className="tabular-nums">{(recording.travel / 1000).toFixed(1)}k pt</span>
        </Property>
        <Property label="Screen covered">
          <Heatmaps size={14} className="text-fg-4" />
          <span className="tabular-nums">{Math.round(recording.coverage * 100)}%</span>
        </Property>
      </dl>

      <div className="my-3 h-px bg-black/[0.06]" />

      <div className="flex h-8 items-center text-[13px] text-fg-4">Pipeline</div>
      <ol>
        {pipeline.map((step, i) => (
          <li key={step.label} className="relative flex gap-2.5 pb-3">
            {i < pipeline.length - 1 ? <span className="absolute top-[20px] left-[7.5px] h-[calc(100%-18px)] w-px bg-black/[0.08]" /> : null}
            {step.done ? <Done size={16} className="mt-0.5 text-[#8b8af0]" /> : <Todo size={16} className="mt-0.5 text-fg-4" />}
            <div className="min-w-0">
              <div className={`text-[13px] font-medium ${step.done ? "text-fg-2" : "text-fg-4"}`}>{step.label}</div>
              <div className="text-[12px] text-fg-4">{step.note}</div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

/** Before anything is recorded: how to make the first recording on this machine. */
export function NoRecording() {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-accent-tint text-accent">
        <Heatmaps size={20} />
      </span>
      <div className="mt-4 text-[15px] font-semibold text-fg">No workflow recorded yet</div>
      <p className="mt-1 max-w-[440px] text-[13px] leading-5 text-fg-3">
        Record one on this machine, then render it into a heatmap. It appears here on its own.
      </p>
      <pre className="mt-5 rounded-lg bg-bg-level-2 px-4 py-3 text-left font-mono text-[12px] leading-5 text-fg-2">
        {`tools/heatmap/record.sh nav-export
tools/heatmap/render.sh nav-export`}
      </pre>
    </div>
  );
}
