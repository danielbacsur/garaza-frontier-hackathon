import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  AUTOMATIC,
  ask,
  brief,
  LimitReached,
  type Picture,
  type Plan,
  reset,
  type Shot,
  stop,
} from "./agent";
import pointer from "./assets/cursor.png";

type Spot = { x: number; y: number };
type Size = { width: number; height: number };
type Request = Spot & { question: string };
type Changed = { click: [number, number] | null; near: boolean };

// A click since the agent last spoke, with the step whose control it was on
// when it was the one pointed at, kept for every look until it is answered.
type Click = { click: [number, number]; step?: number };
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
const LIMIT = "This conversation got long, so I started over. Ask again.";
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

// Reads where the mouse is in points; tauri reports it in pixels of the main
// display whichever display it is on, so that scale is the one to undo.
async function mouseInPoints(): Promise<Spot> {
  const scale = (await primaryMonitor())?.scaleFactor ?? 1;
  const { x, y } = await cursorPosition();

  return { x: x / scale, y: y / scale };
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
  const mouse = await mouseInPoints();
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

// Writes the app's own message for a screen that changed, saying where the
// person clicked when they did, and which step's control that was when it
// was the one pointed at, so the agent can tell whether they took the step.
function automatic(click: [number, number] | null, step?: number) {
  if (!click) return AUTOMATIC;

  const [across, down] = click.map((part) => Math.round(part * 100));
  const where = `${across}% across and ${down}% down the window`;
  const taken = step ? `the control you pointed at for step ${step}, ` : "";

  return `${AUTOMATIC}\n(The user clicked ${taken}${where}.)`;
}

// Turns a spot the model gave in pixels of the screenshot into parts of it,
// since the model answers in either, and the app places parts.
function parts({ x, y }: Spot, picture: Picture): Spot {
  if (x <= 1 && y <= 1) return { x, y };

  return { x: x / picture.width, y: y / picture.height };
}

// Places the bubble along one axis, measured from the cursor's tip, so that
// mirroring both shapes near a screen edge keeps them nested together.
function offset(origin: number, tip: number, size: number, mirrored: boolean) {
  return mirrored ? tip - origin - size : origin - tip;
}

// Draws the second cursor with its bubble lined up on the curve beneath it,
// staying while a task is under way and fading once the words have been read.
export function Cursor() {
  const timer = useRef<number | undefined>(undefined);
  const turn = useRef(0);
  const busy = useRef(false);
  const resting = useRef(true);
  const plan = useRef<Plan | undefined>(undefined);
  const guiding = useRef(false);
  const retried = useRef(false);
  const shown = useRef<number | undefined>(undefined);
  const asked = useRef<string | undefined>(undefined);
  const lastClick = useRef<Click | undefined>(undefined);
  const restarted = useRef(false);
  const queued = useRef(false);
  const request = useRef("");
  const said = useRef("");
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

      const elapsed = Math.min((now - then) / 1000, 1 / 30);
      const speed = velocity.current;

      const pull = (to: number, at: number, v: number) =>
        SPRING * SPRING * (to - at) - 2 * SPRING * v;

      speed.x += pull(target.x, from.x, speed.x) * elapsed;
      speed.y += pull(target.y, from.y, speed.y) * elapsed;

      const next = {
        x: from.x + speed.x * elapsed,
        y: from.y + speed.y * elapsed,
      };
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

    // Says whether a task is still under way, which keeps the cursor on its
    // spot and the screen watched instead of letting it fade away.
    const isPlanned = () => (plan.current?.remaining ?? 0) > 0;

    // The app's message for a changed screen, still naming the click since
    // the agent last spoke, so a look that replaces another loses nothing.
    const remembered = () =>
      automatic(lastClick.current?.click ?? null, lastClick.current?.step);

    // Holds the cursor in place while a task goes on, and otherwise lets it
    // fade, watching for one more change right after it pointed somewhere.
    function settle(reply: string, automatic: boolean, pointed: boolean) {
      // Once the agent has answered, a click it was told about is history.
      if (reply || pointed) lastClick.current = undefined;

      if (isPlanned()) {
        // A plan that arrived on its own gets one more look for a pointer.
        if (!pointed && !reply && !retried.current) {
          retried.current = true;
          void run(remembered(), true);
          return;
        }

        if (!reply) setSpeech(said.current);

        void invoke("watch", { on: true, idle: true });
        return;
      }

      plan.current = undefined;
      guiding.current = pointed;

      // A follow-up that found nothing to say puts the cursor away quietly
      // rather than bringing back words that are no longer about the screen.
      if (automatic && !reply) {
        void invoke("rest");
        return;
      }

      void invoke("watch", { on: pointed, idle: false });
      linger(reply || said.current);
    }

    // Sums a turn up for the log in numbers alone: what set it off, the step
    // shown, how far the task has got and how long the answer took.
    function note(
      automatic: boolean,
      pointed: boolean,
      reply: string,
      ms: number,
    ) {
      const steps = plan.current?.steps ?? [];
      const done = steps.filter((step) => step.done).length;
      const kind = automatic ? "change" : "question";
      const spot = pointed ? "pointed" : "no spot";
      const words = reply ? "spoke" : "silent";
      const step = `step ${shown.current ?? 0}, ${done}/${steps.length} done`;

      void invoke("note", {
        message: `${kind}: ${step}, ${spot}, ${words}, ${ms} ms`,
      });
    }

    // Runs one turn with the screen as it is now, whether the person asked
    // something or the screen changed while a task was under way.
    async function run(message: string, automatic: boolean) {
      const current = ++turn.current;
      const isCurrent = () => current === turn.current;
      const started = performance.now();
      let pointed = false;
      let released = false;

      asked.current = automatic ? undefined : message;
      window.clearTimeout(timer.current);
      setMotion("still");
      setLeaving(false);
      setSpeech("");

      // The screen stays watched while the agent answers, so that whatever
      // the person does meanwhile is looked at rather than lost.
      void invoke("watch", { on: true, idle: isPlanned() });

      try {
        if (busy.current) await stop();

        // A turn replaced or dismissed while waiting must not send anything.
        if (!isCurrent()) return;

        busy.current = true;

        const { generation, picture } = await invoke<Shot>("screen");

        if (!isCurrent()) return;

        // A task is written above every message, so that a look at the
        // screen can start a conversation of its own and still know it.
        const task = plan.current;
        const text = task
          ? `${brief(task, said.current, request.current)}\n\n${message}`
          : message;
        const fresh = automatic && task !== undefined;

        const reply = await ask(
          text,
          picture,
          {
            // The spot arrives before the words, so the cursor sets off at
            // once and the full call only confirms it.
            onPreview: (spot) => {
              if (!isCurrent() || !picture) return;

              pointed = true;
              void invoke("point", { ...parts(spot, picture), generation });
            },

            onPoint: async ({ x, y, step }) => {
              if (!isCurrent() || !picture) return;

              // Counted at once, since the words follow straight after, and
              // taken back if the spot was on a picture that is out of date.
              pointed = true;
              shown.current = step ?? undefined;

              // Pointing at a step means the ones before it were seen done,
              // and a click on the step itself has been judged by now.
              if (step && plan.current) {
                const steps = plan.current.steps.map((s, index) => ({
                  ...s,
                  done: s.done || index < step - 1,
                  clicked: s.clicked && index > step - 1,
                }));
                const remaining = steps.filter((s) => !s.done).length;

                plan.current = { ...plan.current, steps, remaining };
              }

              const used = await invoke<boolean>("point", {
                ...parts({ x, y }, picture),
                generation,
              });

              if (!used) pointed = false;
            },

            onText: (text) => {
              if (!isCurrent()) return;

              // Words about something other than a spot are said beside the
              // mouse rather than on whatever was pointed at before.
              if (!pointed && !released) {
                released = true;
                void invoke("release");
              }

              said.current = text;
              setSpeech(text);
            },

            // The agent forgot the conversation, and with it any task.
            onRestart: () => {
              if (!isCurrent()) return;

              plan.current = undefined;
            },

            onPlan: (next) => {
              if (!isCurrent()) return;

              plan.current = next;
            },
          },
          fresh,
        );

        if (isCurrent()) {
          const ms = Math.round(performance.now() - started);

          settle(reply, automatic, pointed);
          note(automatic, pointed, reply, ms);
        }
      } catch (error) {
        if (!isCurrent()) return;

        void invoke("report", { message: `turn failed: ${error}` });
        plan.current = undefined;

        const words = error instanceof LimitReached ? LIMIT : FALLBACK;

        setSpeech(words);
        linger(words);
      } finally {
        if (isCurrent()) {
          busy.current = false;
          asked.current = undefined;
          restarted.current = false;

          // Changes that arrived while this turn was answering get one look.
          if (queued.current) {
            queued.current = false;

            if (isPlanned() || guiding.current) void run(remembered(), true);
          }
        }
      }
    }

    // Appears just below and to the right of the mouse to take a question,
    // whether or not the mouse is moving at the time.
    const asking = listen<Request>("think", async ({ payload }) => {
      const { x, y, question } = payload;

      resting.current = false;
      shown.current = undefined;
      lastClick.current = undefined;
      request.current = question;
      put(beside(await toOverlay({ x, y })));
      void run(question, false);
    });

    // The screen moved on while a task, a pointed step or an answer was under
    // way, so the agent looks again, from beside the mouse if it was put
    // away, and a question still being answered is asked of the new screen.
    const changing = listen<Changed>("changed", async ({ payload }) => {
      if (!busy.current && !isPlanned() && !guiding.current) return;

      // A click on the spot pointed at for a step is noted on that step, so
      // a fresh look knows it was taken even when the result is too small
      // to make out, such as a box being unticked.
      const step = payload.near ? shown.current : undefined;

      if (payload.click) lastClick.current = { click: payload.click, step };

      if (step && plan.current) {
        const steps = plan.current.steps.map((s, index) =>
          index === step - 1 ? { ...s, clicked: true } : s,
        );

        plan.current = { ...plan.current, steps };
      }

      // A step that was pointed at gets one look, not one after every click.
      guiding.current = false;
      retried.current = false;

      // A turn starts over once for a newer screen; on a screen that keeps
      // changing it would otherwise never get to answer, so later changes
      // wait for its answer and get one look of their own after it.
      if (busy.current && restarted.current) {
        queued.current = true;
        return;
      }

      restarted.current = busy.current;

      if (resting.current) {
        resting.current = false;
        put(beside(await toOverlay(await mouseInPoints())));
      }

      const question = busy.current ? asked.current : undefined;

      void run(question ?? remembered(), !question);
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
    // screen while there is something to say or a task to follow.
    const sleeping = listen("rest", () => {
      resting.current = true;

      // Someone may still be reaching for what was pointed at, so the screen
      // stays watched for that one step after the cursor has gone.
      if (!isPlanned() && !guiding.current) {
        void invoke("watch", { on: false, idle: false });
      }

      window.clearTimeout(timer.current);
      goal.current = undefined;
      here.current = undefined;
      setSpot(undefined);
      setSpeech("");
      setLeaving(false);
    });

    // The person dismissed the cursor, so the conversation and any task end
    // here, and the next question starts from nothing.
    const forgetting = listen("forget", () => {
      turn.current += 1;
      busy.current = false;
      plan.current = undefined;
      guiding.current = false;
      shown.current = undefined;
      asked.current = undefined;
      lastClick.current = undefined;
      restarted.current = false;
      queued.current = false;
      request.current = "";
      said.current = "";
      reset();
    });

    return () => {
      const listeners = [
        asking,
        changing,
        pointing,
        trailing,
        sleeping,
        forgetting,
      ];

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
