import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ask, reset, type Shot } from "./agent";
import pointer from "./assets/cursor.png";

type Spot = { x: number; y: number };
type Size = { width: number; height: number };
type Request = Spot & { question: string };
type Motion = "still" | "trailing" | "gliding";

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

// Room the cursor itself takes beside its bubble near a screen edge.
const EDGE_MARGIN = 32;
const LINGER_MS = 6_000;
const READING_MS_PER_CHARACTER = 45;
const FADE_MS = 350;
const SHY_CHECK_MS = 120;
const SHY_DISTANCE = 28;
const FALLBACK = "Something went wrong. Please try again.";
const REST_GAP = 28;
const SPRING = 14;

// Converts a screen position into the overlay's own coordinates, because
// macos keeps the window below the menu bar.
async function toOverlay({ x, y }: Spot): Promise<Spot> {
  const overlay = getCurrentWindow();
  const scale = await overlay.scaleFactor();
  const origin = (await overlay.outerPosition()).toLogical(scale);

  return { x: x - origin.x, y: y - origin.y };
}

// Checks whether the bubble fits to the right of a spot, keeping the room
// the cursor needs too, the one rule for where the bubble may sit.
function fitsRight(x: number) {
  return x + BUBBLE_WIDTH + EDGE_MARGIN <= window.innerWidth;
}

// Checks whether the bubble fits below a spot, which decides both where
// the cursor rests and which way the bubble is drawn.
function fitsBelow(y: number) {
  return y + BUBBLE_HEIGHT <= window.innerHeight;
}

// Picks a resting spot just beside the mouse, below and to its right unless
// the bubble would run off that side, so it never ends up on the mouse.
function beside({ x, y }: Spot): Spot {
  const right = fitsRight(x + REST_GAP);
  const below = fitsBelow(y + REST_GAP);

  return {
    x: right ? x + REST_GAP : x - REST_GAP,
    y: below ? y + REST_GAP : y - REST_GAP,
  };
}

// Checks whether the real mouse is closing in on the bubble, so that it can
// step aside instead of covering whatever someone is reaching for.
async function isMouseNear(bubble: HTMLElement, margin: number) {
  const overlay = getCurrentWindow();
  const scale = await overlay.scaleFactor();
  const mouse = (await cursorPosition()).toLogical(scale);
  const origin = (await overlay.outerPosition()).toLogical(scale);
  const box = bubble.getBoundingClientRect();
  const x = mouse.x - origin.x;
  const y = mouse.y - origin.y;

  return (
    x > box.left - margin &&
    x < box.right + margin &&
    y > box.top - margin &&
    y < box.bottom + margin
  );
}

// Places the bubble along one axis, measured from the cursor's tip, so that
// mirroring both shapes near a screen edge keeps them nested together.
function offset(origin: number, tip: number, size: number, mirrored: boolean) {
  return mirrored ? tip - origin - size : origin - tip;
}

// Draws the second cursor with its bubble lined up on the curve beneath it,
// trailing the mouse while it talks and fading once the words have been read.
export function Cursor() {
  const timer = useRef<number | undefined>(undefined);
  const turn = useRef(0);
  const resting = useRef(true);
  const here = useRef<Spot | undefined>(undefined);
  const goal = useRef<Spot | undefined>(undefined);
  const velocity = useRef<Spot>({ x: 0, y: 0 });
  const frame = useRef<number | undefined>(undefined);
  const origin = useRef<Spot>({ x: 0, y: 0 });
  const bubble = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot>();
  const [motion, setMotion] = useState<Motion>("still");
  const [speech, setSpeech] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [shy, setShy] = useState(false);
  const [size, setSize] = useState<Size>();

  useEffect(() => {
    const overlay = getCurrentWindow();

    // Notes where the overlay sits on screen, so that mouse positions can be
    // turned into its own coordinates on every move without asking again.
    async function measure() {
      const scale = await overlay.scaleFactor();
      const { x, y } = (await overlay.outerPosition()).toLogical(scale);

      origin.current = { x, y };
    }

    void measure();
    const moving = overlay.onMoved(() => void measure());

    // Places the cursor straight away, ending any trailing after the mouse,
    // for moves that animate with a transition of their own instead.
    function put(spot: Spot) {
      goal.current = undefined;
      here.current = spot;
      velocity.current = { x: 0, y: 0 };
      setSpot(spot);
    }

    // Moves the cursor one display frame along a damped spring toward its
    // spot beside the mouse, so it follows smoothly however updates arrive.
    function spring(now: number, then = now) {
      const target = goal.current;
      const from = here.current;

      frame.current = undefined;

      if (!target) return;

      if (!from) {
        here.current = target;
        setSpot(target);
        return;
      }

      const step = Math.min((now - then) / 1000, 1 / 30);
      const speed = velocity.current;

      const pull = (to: number, at: number, v: number) =>
        SPRING * SPRING * (to - at) - 2 * SPRING * v;

      speed.x += pull(target.x, from.x, speed.x) * step;
      speed.y += pull(target.y, from.y, speed.y) * step;

      const next = { x: from.x + speed.x * step, y: from.y + speed.y * step };
      const near = Math.hypot(target.x - next.x, target.y - next.y) < 0.3;
      const slow = Math.hypot(speed.x, speed.y) < 2;

      here.current = near && slow ? target : next;
      setSpot(here.current);

      if (!(near && slow)) {
        frame.current = requestAnimationFrame((later) => spring(later, now));
      }
    }

    // Leaves the bubble up long enough to read, then fades out before the
    // window hides, so that it never vanishes in the middle of a sentence.
    function linger(text: string) {
      const wait = LINGER_MS + text.length * READING_MS_PER_CHARACTER;

      timer.current = window.setTimeout(() => {
        setLeaving(true);
        timer.current = window.setTimeout(() => void invoke("rest"), FADE_MS);
      }, wait);
    }

    // Answers one question about the screen as it was pictured, pointing
    // where the agent points and talking beside the mouse otherwise.
    async function run(question: string) {
      const current = ++turn.current;
      const isCurrent = () => current === turn.current;
      let pointed = false;
      let released = false;

      window.clearTimeout(timer.current);
      setMotion("still");
      setLeaving(false);
      setSpeech("");

      try {
        const { generation, picture } = await invoke<Shot>("screen");

        const reply = await ask(question, picture, {
          onPoint: ({ x, y }) => {
            if (!isCurrent()) return;

            pointed = true;
            void invoke("point", { x, y, generation });
          },

          onText: (text) => {
            if (!isCurrent()) return;

            // Words about something other than a spot are said beside the
            // mouse rather than on whatever was pointed at before.
            if (!pointed && !released) {
              released = true;
              void invoke("release");
            }

            setSpeech(text);
          },
        });

        if (isCurrent()) linger(reply);
      } catch (error) {
        if (!isCurrent()) return;

        void invoke("report", { message: `turn failed: ${error}` });
        setSpeech(FALLBACK);
        linger(FALLBACK);
      }
    }

    // Appears just below and to the right of the mouse to take a question,
    // whether or not the mouse is moving at the time.
    const asking = listen<Request>("think", async ({ payload }) => {
      const { x, y, question } = payload;

      resting.current = false;
      put(beside(await toOverlay({ x, y })));
      void run(question);
    });

    // Moves that arrive after the cursor was sent away belong to a turn that
    // is over, and would otherwise bring it back with nothing to say.
    const pointing = listen<Spot>("point", async ({ payload }) => {
      const spot = await toOverlay(payload);

      // Motion and place change together, so no mouse move lands between.
      if (resting.current) return;

      setMotion("gliding");
      put(spot);
    });

    // Trails the mouse whenever there is nothing to point at, resting just
    // beside it like a companion.
    const trailing = listen<Spot>("mouse", ({ payload }) => {
      if (resting.current) return;

      goal.current = beside({
        x: payload.x - origin.current.x,
        y: payload.y - origin.current.y,
      });

      setMotion("trailing");
      frame.current ??= requestAnimationFrame((now) => spring(now));
    });

    // Puts the cursor away once its words have been read, so it is only on
    // screen while there is something to say.
    const sleeping = listen("rest", () => {
      resting.current = true;
      window.clearTimeout(timer.current);
      goal.current = undefined;
      here.current = undefined;
      setSpot(undefined);
      setSpeech("");
      setLeaving(false);
    });

    const forgetting = listen("forget", () => {
      turn.current += 1;
      reset();
    });

    return () => {
      const listeners = [asking, pointing, trailing, sleeping, forgetting];

      for (const listener of [...listeners, moving]) {
        void listener.then((stop) => stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!speech) return;

    const check = window.setInterval(() => {
      // Resting beside the mouse, it only gives way once the mouse is on it.
      const margin = motion === "gliding" ? SHY_DISTANCE : 0;

      if (bubble.current) void isMouseNear(bubble.current, margin).then(setShy);
    }, SHY_CHECK_MS);

    return () => {
      window.clearInterval(check);
      setShy(false);
    };
  }, [speech, motion]);

  useLayoutEffect(() => {
    const box = bubble.current;

    setSize(
      box ? { width: box.offsetWidth, height: box.offsetHeight } : undefined,
    );
  }, [speech]);

  if (!spot) return null;

  const flipX = !fitsRight(spot.x);
  const flipY = !fitsBelow(spot.y);
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
        className={`glide-x ${motion}`}
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
          className={`anchor ${motion}`}
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
