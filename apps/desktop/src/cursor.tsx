import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import pointer from "./assets/cursor.png";

type Spot = { x: number; y: number };
type Size = { width: number; height: number };

const POINTER_WIDTH = 16;
const POINTER_SCALE = POINTER_WIDTH / 96;
const TIP = { x: 6 * POINTER_SCALE, y: 2 * POINTER_SCALE };

// The curve under the cursor, measured from its image, and how far the bubble's
// corner sits from it along the 45 degree line running out of that curve.
const NOTCH = 0.652 * POINTER_WIDTH;
const NOTCH_GAP = 7;
const BUBBLE_ORIGIN = NOTCH + NOTCH_GAP * Math.SQRT1_2;

const BUBBLE_WIDTH = 220;
const BUBBLE_HEIGHT = 110;
const LINGER_MS = 6_000;
const READING_MS_PER_CHARACTER = 45;
const FADE_MS = 350;
const SHY_CHECK_MS = 120;
const SHY_DISTANCE = 28;

// Converts a screen position into the overlay's own coordinates, because
// macos keeps the window below the menu bar.
async function toOverlay({ x, y }: Spot): Promise<Spot> {
  const overlay = getCurrentWindow();
  const scale = await overlay.scaleFactor();
  const origin = (await overlay.outerPosition()).toLogical(scale);

  return { x: x - origin.x, y: y - origin.y };
}

// Checks whether the real mouse is closing in on the bubble, so that it can
// step aside instead of covering whatever someone is reaching for.
async function isMouseNear(bubble: HTMLElement) {
  const overlay = getCurrentWindow();
  const scale = await overlay.scaleFactor();
  const mouse = (await cursorPosition()).toLogical(scale);
  const origin = (await overlay.outerPosition()).toLogical(scale);
  const box = bubble.getBoundingClientRect();
  const x = mouse.x - origin.x;
  const y = mouse.y - origin.y;

  return (
    x > box.left - SHY_DISTANCE &&
    x < box.right + SHY_DISTANCE &&
    y > box.top - SHY_DISTANCE &&
    y < box.bottom + SHY_DISTANCE
  );
}

// Places the bubble along one axis, measured from the cursor's tip, so that
// mirroring both shapes near a screen edge keeps them nested together.
function offset(origin: number, tip: number, size: number, mirrored: boolean) {
  return mirrored ? tip - origin - size : origin - tip;
}

// Draws the second cursor with its bubble lined up on the curve beneath it,
// trailing on a softer spring and fading once the words have been read.
export function Cursor() {
  const timer = useRef<number | undefined>(undefined);
  const bubble = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot>();
  const [gliding, setGliding] = useState(false);
  const [speech, setSpeech] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [shy, setShy] = useState(false);
  const [size, setSize] = useState<Size>();

  useEffect(() => {
    const thinking = listen<Spot>("think", async ({ payload }) => {
      window.clearTimeout(timer.current);
      setGliding(false);
      setLeaving(false);
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

      timer.current = window.setTimeout(() => {
        setLeaving(true);
        timer.current = window.setTimeout(() => void invoke("rest"), FADE_MS);
      }, wait);
    });

    const resting = listen("rest", () => {
      window.clearTimeout(timer.current);
      setSpot(undefined);
      setSpeech("");
      setLeaving(false);
    });

    return () => {
      for (const listener of [thinking, pointing, speaking, resting]) {
        void listener.then((stop) => stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!speech) return;

    const check = window.setInterval(() => {
      if (bubble.current) void isMouseNear(bubble.current).then(setShy);
    }, SHY_CHECK_MS);

    return () => {
      window.clearInterval(check);
      setShy(false);
    };
  }, [speech]);

  useLayoutEffect(() => {
    const box = bubble.current;

    setSize(
      box ? { width: box.offsetWidth, height: box.offsetHeight } : undefined,
    );
  }, [speech]);

  if (!spot) return null;

  const flipX = spot.x + BUBBLE_WIDTH + 32 > window.innerWidth;
  const flipY = spot.y + BUBBLE_HEIGHT > window.innerHeight;
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;

  const classes = [
    "bubble",
    !size && "measuring",
    flipX && "flip-x",
    flipY && "flip-y",
    shy && "shy",
  ];

  return (
    <div className={leaving ? "scene leaving" : "scene"}>
      <div
        className={gliding ? "glide-x gliding" : "glide-x"}
        style={{ transform: `translateX(${spot.x}px)` }}
      >
        <div
          className="glide-y"
          style={{ transform: `translateY(${spot.y}px)` }}
        >
          <div
            className="mirror"
            style={{
              left: -TIP.x,
              top: -TIP.y,
              transform: `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`,
              transformOrigin: `${TIP.x}px ${TIP.y}px`,
            }}
          >
            <img
              className={speech ? "pointer" : "pointer thinking"}
              src={pointer}
              width={POINTER_WIDTH}
              alt=""
              style={{ transformOrigin: `${TIP.x}px ${TIP.y}px` }}
            />
          </div>
        </div>
      </div>

      {speech && (
        <div
          className={gliding ? "anchor gliding" : "anchor"}
          style={{ transform: `translate(${spot.x}px, ${spot.y}px)` }}
        >
          <div
            ref={bubble}
            className={classes.filter(Boolean).join(" ")}
            style={{
              left: offset(BUBBLE_ORIGIN, TIP.x, width, flipX),
              top: offset(BUBBLE_ORIGIN, TIP.y, height, flipY),
            }}
          >
            {speech}
          </div>
        </div>
      )}
    </div>
  );
}
