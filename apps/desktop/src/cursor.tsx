import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

type Spot = { x: number; y: number };

const BUBBLE_WIDTH = 300;
const BUBBLE_HEIGHT = 140;
const LINGER_MS = 12_000;
const READING_MS_PER_CHARACTER = 60;

// Converts a screen position into the overlay's own coordinates, because
// macos keeps the window below the menu bar.
async function toOverlay({ x, y }: Spot): Promise<Spot> {
  const overlay = getCurrentWindow();
  const scale = await overlay.scaleFactor();
  const origin = (await overlay.outerPosition()).toLogical(scale);

  return { x: x - origin.x, y: y - origin.y };
}

// Draws the second cursor and its speech bubble, thinking beside the real
// cursor first and leaving by itself once there has been time to read.
export function Cursor() {
  const timer = useRef<number | undefined>(undefined);
  const [spot, setSpot] = useState<Spot>();
  const [gliding, setGliding] = useState(false);
  const [speech, setSpeech] = useState("");

  useEffect(() => {
    const thinking = listen<Spot>("think", async ({ payload }) => {
      window.clearTimeout(timer.current);
      setGliding(false);
      setSpeech("");
      setSpot(await toOverlay(payload));
    });

    const pointing = listen<Spot>("point", async ({ payload }) => {
      setGliding(true);
      setSpot(await toOverlay(payload));
    });

    const speaking = listen<string>("say", ({ payload }) => {
      const wait = LINGER_MS + payload.length * READING_MS_PER_CHARACTER;

      setSpeech(payload);
      timer.current = window.setTimeout(() => void invoke("rest"), wait);
    });

    const resting = listen("rest", () => {
      window.clearTimeout(timer.current);
      setSpot(undefined);
      setSpeech("");
    });

    return () => {
      for (const listener of [thinking, pointing, speaking, resting]) {
        void listener.then((stop) => stop());
      }
    };
  }, []);

  if (!spot) return null;

  const flipX = spot.x + BUBBLE_WIDTH + 48 > window.innerWidth;
  const flipY = spot.y + BUBBLE_HEIGHT > window.innerHeight;

  return (
    <div
      className={gliding ? "cursor gliding" : "cursor"}
      style={{ transform: `translate(${spot.x}px, ${spot.y}px)` }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
        <path d="M3 2l7.5 20 3-8.5L22 10.5z" />
      </svg>

      <div
        className={`bubble${flipX ? " flip-x" : ""}${flipY ? " flip-y" : ""}`}
      >
        {speech || (
          <span className="dots" aria-label="Thinking">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </div>
  );
}
