import type { ReactNode } from "react";

/** 16px line icons (1.5px strokes, current colour). */
function Icon({ children, size = 16, className = "" }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export type IconProps = { size?: number; className?: string };

/* Chrome. */

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.75 6.5 8 9.75l3.25-3.25" />
  </Icon>
);

/** The small filled caret after a sidebar section label. */
export const Caret = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6.25h6L8 10z" fill="currentColor" strokeWidth={1} />
  </Icon>
);

export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.25" cy="7.25" r="4.25" />
    <path d="m10.5 10.5 2.75 2.75" />
  </Icon>
);

export const ArrowUpRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 11 11 5M6 5h5v5" />
  </Icon>
);

/* Sidebar views. */

export const Overview = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.75" y="2.75" width="4.25" height="5.5" rx="1.25" />
    <rect x="9" y="2.75" width="4.25" height="3.25" rx="1.25" />
    <rect x="2.75" y="10.25" width="4.25" height="3" rx="1.25" />
    <rect x="9" y="8" width="4.25" height="5.25" rx="1.25" />
  </Icon>
);

/** Two people, one behind the other. */
export const Users = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.25" cy="5.5" r="2.25" />
    <path d="M2.5 12.75c.35-2 1.85-3.25 3.75-3.25S9.65 10.75 10 12.75" />
    <path d="M10.25 3.5a2.25 2.25 0 0 1 0 4.25M11.75 9.75c.9.5 1.5 1.5 1.75 3" />
  </Icon>
);

/** A speech bubble with a question mark: what people ask the second cursor. */
export const Questions = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 13.25c3 0 5.25-2.15 5.25-5.25S11 2.75 8 2.75 2.75 4.9 2.75 8c0 1 .25 1.9.7 2.7l-.7 2.55 2.55-.7c.8.45 1.7.7 2.7.7Z" />
    <path d="M6.6 6.6a1.45 1.45 0 0 1 2.8.5c0 .95-1.4 1.2-1.4 2" />
    <circle cx="8" cy="10.85" r=".1" fill="currentColor" />
  </Icon>
);

/** A pointer over soft rings: where the cursor dwelt. */
export const Heatmaps = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.5" cy="6.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="6.5" r="3.5" opacity=".55" />
    <path d="m9.25 9.25 3.5 1.25-1.5.75-.75 1.5z" fill="currentColor" strokeWidth={1.1} />
  </Icon>
);

/* Agent folders and things it knows. */

/** A four-pointed spark: a procedure the agent loads when it needs it. */
export const Skills = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 2.75c.35 2.6 1.15 3.4 3.75 3.75C8.15 6.85 7.35 7.65 7 10.25 6.65 7.65 5.85 6.85 3.25 6.5 5.85 6.15 6.65 5.35 7 2.75z" />
    <path d="M11.5 9.75c.2 1.25.55 1.6 1.75 1.75-1.2.15-1.55.5-1.75 1.75-.2-1.25-.55-1.6-1.75-1.75 1.2-.15 1.55-.5 1.75-1.75z" />
  </Icon>
);

export const Workflows = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="2.75" width="4" height="3.5" rx="1" />
    <rect x="9.5" y="9.75" width="4" height="3.5" rx="1" />
    <path d="M4.5 6.25v2.5a1.5 1.5 0 0 0 1.5 1.5h3.5" />
  </Icon>
);

/** A window with a title bar: a piece of software people work in. */
export const App = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.75" />
    <path d="M2.5 5.75h11" />
  </Icon>
);

export const Schedules = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.25l2 1.25" />
  </Icon>
);

/** A filled dot inside a ring: a recording. */
export const Record = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />
  </Icon>
);

export const Click = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 7 2.5-3 1.25L8.75 13z" />
    <path d="M3.5 3.5 4.5 4.5M6 2v1.5M2 6h1.5" />
  </Icon>
);

/** A wavy line from one point to another: how far the cursor travelled. */
export const Travel = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="3.5" cy="12" r="1.25" />
    <circle cx="12.5" cy="4" r="1.25" />
    <path d="M4.5 11c2-1 1-4 3.5-4.5S10 7 11.5 5" />
  </Icon>
);

/* States. */

/** A filled disc with a check: the step is done. */
export const Done = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" fill="currentColor" stroke="none" />
    <path d="m5.5 8.15 1.75 1.75 3.25-3.5" stroke="#fff" strokeWidth={1.6} />
  </Icon>
);

/** A dashed ring: the step has not started. */
export const Todo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.1" />
  </Icon>
);

/** Three quarters of a ring; rotated by CSS while something is in progress. */
export const Spinner = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" strokeWidth={1.75} opacity=".22" />
    <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" strokeWidth={1.75} />
  </Icon>
);
