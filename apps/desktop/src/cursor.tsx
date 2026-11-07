import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

type Target = { x: number; y: number; caption: string };

// Draws the second cursor, measuring each target from where the overlay really
// is, because macos keeps the window below the menu bar.
export function Cursor() {
  const [target, setTarget] = useState<Target>();

  useEffect(() => {
    const point = listen<Target>("point", async ({ payload }) => {
      const overlay = getCurrentWindow();
      const scale = await overlay.scaleFactor();
      const origin = (await overlay.outerPosition()).toLogical(scale);

      setTarget({
        ...payload,
        x: payload.x - origin.x,
        y: payload.y - origin.y,
      });
    });

    return () => void point.then((stop) => stop());
  }, []);

  if (!target) return null;

  return (
    <div
      className="cursor"
      style={{ transform: `translate(${target.x}px, ${target.y}px)` }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
        <path d="M3 2l7.5 20 3-8.5L22 10.5z" />
      </svg>

      <span>{target.caption}</span>
    </div>
  );
}
