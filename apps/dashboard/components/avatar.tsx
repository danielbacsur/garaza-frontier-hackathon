import type { CSSProperties } from "react";

/*
 * A person is a warm circle with initials, the firm's workspace a rounded square on the accent
 * gradient. Every length is a fraction of `size`, so an
 * avatar is the same drawing at any size.
 */

/** "Kiss Péter" → "KP": the first letters of the first two words. */
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
}

const hairline = (size: number) => size / 28;
const corners = (size: number) => (size * 2) / 7;

const accentFill = "linear-gradient(140deg, #9a9aff 0%, #7070ff 55%, #5a5ae6 100%)";
const accentRing = (size: number) =>
  `inset 0 0 0 ${hairline(size)}px rgb(0 0 0 / 0.1), inset 0 ${hairline(size)}px 0 rgb(255 255 255 / 0.25)`;

/** A person: initials on a warm circle, in place of a photo. */
export function PersonAvatar({ name, size, ring }: { name: string; size: number; ring?: boolean }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: (size * 3) / 7,
    color: "#8a5a12",
    background: "linear-gradient(140deg, #fff1df 0%, #f8d3a6 100%)",
    boxShadow: ring
      ? `0 0 0 2px var(--bg), inset 0 0 0 ${hairline(size)}px rgb(0 0 0 / 0.06)`
      : `inset 0 0 0 ${hairline(size)}px rgb(0 0 0 / 0.06)`,
  };
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full leading-none font-semibold"
      style={style}
    >
      {initials(name)}
    </span>
  );
}

/** The firm's workspace mark: its initial in white on the accent gradient. */
export function WorkspaceMark({ name, size }: { name: string; size: number }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: corners(size),
    fontSize: (size * 3) / 5,
    background: accentFill,
    boxShadow: accentRing(size),
  };
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center leading-none font-semibold text-white" style={style}>
      {name.charAt(0)}
    </span>
  );
}
