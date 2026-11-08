import { Client, type ClientSession, SessionNotActiveError } from "eve/client";

const client = new Client({
  baseUrl: import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:3001",
});

// A picture of the window in use, as a JPEG in base64.
export type Picture = { app: string; title: string; image: string };

// The latest picture with its number, which pointing has to quote back.
export type Shot = { generation: number; picture: Picture | null };

// A spot on the picture, as parts of its width and height.
export type Spot = { x: number; y: number };

// The message the app sends on its own once the screen changes, which the
// agent's instructions quote word for word.
export const AUTOMATIC =
  "(The screen changed after the user acted. No message from the user.)";

// Thrown when the conversation stops to wait for someone to approve going on,
// which only its spending cap does, since this agent asks nothing itself.
export class LimitReached extends Error {}

// A task's steps, and how many are not done yet.
export type Plan = {
  task: string;
  requirements: string[];
  steps: { instruction: string; done: boolean }[];
  remaining: number;
};

// Where the agent pointed, with the number of the task step it was for.
export type Pointed = Spot & { step: number | null };

type Pointer = Pointed & { say: string };

type Listeners = {
  onPoint: (spot: Pointed) => void;
  onText: (text: string) => void;
  onPlan: (plan: Plan) => void;
  onRestart: () => void;
};

let session: Promise<ClientSession> | undefined;
let aside: Promise<ClientSession> | undefined;
let sending: Promise<unknown> | undefined;

// Writes what a fresh look needs to know about the task under way, since each
// look during a task starts a conversation of its own to stay quick.
export function brief(plan: Plan, last: string) {
  const steps = plan.steps.map(
    (step, index) =>
      `${index + 1}. ${step.done ? "(done) " : ""}${step.instruction}`,
  );

  return [
    `Task under way: ${plan.task}`,
    "Steps:",
    ...steps,
    ...(last ? [`You last said: "${last}"`] : []),
  ].join("\n");
}

// Removes the markdown models sometimes add anyway, because the bubble shows
// plain text and stray symbols would read as noise.
export function plain(text: string) {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "");
}

// Puts the message and the picture of the window together, naming the app
// and window so the agent knows what it is looking at.
function compose(message: string, picture: Picture | null) {
  if (!picture) {
    return `${message}\n\n(No window could be pictured, so nothing is shown.)`;
  }

  const shown = picture.title
    ? `${picture.app}, window "${picture.title}"`
    : picture.app;

  return [
    { type: "text" as const, text: `${message}\n\nScreenshot of ${shown}:` },

    {
      type: "file" as const,
      data: picture.image,
      mediaType: "image/jpeg",
    },
  ];
}

// Starts a conversation the first time and hands back the same one after
// that, holding the promise so two quick questions never open two of them.
async function deliver(message: string, picture: Picture | null) {
  const content = compose(message, picture);

  if (session) return (await session).send(content);

  const created = client.sessions.create({ message: content });
  const pending = created.then(({ session }) => session);

  // A start that fails late must not wipe out a newer conversation.
  session = pending;
  pending.catch(() => {
    if (session === pending) session = undefined;
  });

  return (await created).delivery;
}

// Starts a conversation for this one message alone, which keeps a look at
// the screen during a task to a few thousand tokens however long it goes on.
async function deliverAside(message: string, picture: Picture | null) {
  const created = client.sessions.create({
    message: compose(message, picture),
  });

  aside = created.then(({ session }) => session);

  return (await created).delivery;
}

// Sends a message, and starts over once if the agent no longer knows the
// conversation, for example after it restarted, saying so to the caller.
async function send(
  message: string,
  picture: Picture | null,
  onRestart: () => void,
  fresh: boolean,
) {
  const opened = session;

  try {
    if (fresh) return await deliverAside(message, picture);

    return await deliver(message, picture);
  } catch (error) {
    // A conversation ended in the meantime, by dismissing, stays ended.
    if (!SessionNotActiveError.is(error) || session !== opened) throw error;

    session = undefined;
    onRestart();

    return deliver(message, picture);
  }
}

// Asks the agent and reports each word as it arrives, so the cursor can move
// and start talking long before the whole reply has been written.
export async function ask(
  message: string,
  picture: Picture | null,
  { onPoint, onText, onPlan, onRestart }: Listeners,
  fresh = false,
) {
  const sent = send(message, picture, onRestart, fresh);

  sending = sent;

  const delivery = await sent;
  const tools = new Map<string, string>();
  const texts = new Set<string>();
  let text = "";

  // Shows whatever was said last, since a step that also calls a tool marks
  // its words as narration even though they are all this bubble has.
  const say = (words: string) => {
    text = words;
    onText(plain(text));
  };

  for await (const event of delivery.stream()) {
    switch (event.type) {
      case "content.delta": {
        const { partId, kind, delta } = event.data;

        // Each new part of text is said on its own, not after the last one.
        if (kind === "text" && !texts.has(partId)) {
          texts.add(partId);
          text = "";
        }

        if (texts.has(partId)) say(text + delta);
        break;
      }

      case "content.completed": {
        if (event.data.kind === "text") say(String(event.data.value ?? ""));
        break;
      }

      case "call.requested": {
        tools.set(event.data.callId, event.data.capability.name);
        break;
      }

      case "call.settled": {
        const { callId, outcome, output } = event.data;

        if (outcome !== "completed") break;

        if (tools.get(callId) === "point_at") {
          const { x, y, step, say: words } = output as Pointer;

          onPoint({ x, y, step });
          if (words) say(words);
        }

        if (tools.get(callId) === "plan") onPlan(output as Plan);

        break;
      }

      case "interaction.opened": {
        // Nobody can approve more spending from a bubble, so it starts over.
        reset();
        throw new LimitReached();
      }
    }
  }

  // A conversation made for one look is over once it has been read.
  if (fresh) {
    void aside?.then(
      (open) => open.end(),
      () => undefined,
    );
    aside = undefined;
  }

  return plain(text);
}

// Stops the turn that is running, so a new question never has to share it
// with an answer about a screen that is no longer there.
export async function stop() {
  try {
    // A message still on its way would start its turn after the cancel.
    await sending?.catch(() => undefined);
    await (await aside)?.cancel();
    await (await session)?.cancel();
  } catch {
    // A turn that already ended has nothing left to stop.
  }
}

// Ends the conversation, so the next question starts fresh and no longer
// carries what the previous one was about.
export function reset() {
  void session?.then(
    (open) => open.end(),
    () => undefined,
  );
  session = undefined;
}
