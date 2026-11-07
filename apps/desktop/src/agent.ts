import { Client, type ClientSession } from "eve/client";

const client = new Client({
  baseUrl: import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:3001",
});

// A picture of the window in use, as a JPEG in base64.
export type Picture = { app: string; title: string; image: string };

// The latest picture with its number, which pointing has to quote back.
export type Shot = { generation: number; picture: Picture | null };

// A spot on the picture, as parts of its width and height.
export type Spot = { x: number; y: number };

type Pointer = Spot & { say: string };

type Listeners = {
  onPoint: (spot: Spot) => void;
  onText: (text: string) => void;
};

let session: ClientSession | undefined;

// Tells a pointing result apart from any other tool output on the stream,
// which reports every call in the same shape.
const isPointer = (output: unknown): output is Pointer =>
  typeof output === "object" && output !== null && "say" in output;

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

// Reuses the open conversation or starts one, sending the picture with the
// message so the agent sees the screen as it was asked about.
async function deliver(message: string, picture: Picture | null) {
  const content = compose(message, picture);

  if (session) return session.send(content);

  const created = await client.sessions.create({ message: content });

  session = created.session;

  return created.delivery;
}

// Asks the agent and reports each word as it arrives, so the cursor can move
// and start talking long before the whole reply has been written.
export async function ask(
  message: string,
  picture: Picture | null,
  { onPoint, onText }: Listeners,
) {
  const delivery = await deliver(message, picture);
  let text = "";

  for await (const event of delivery.stream()) {
    if (event.type === "content.delta" && event.data.kind === "text") {
      text += event.data.delta;
      onText(text);
    }

    if (event.type === "content.completed" && event.data.kind === "text") {
      text = String(event.data.value);
      onText(text);
    }

    if (event.type === "call.settled" && isPointer(event.data.output)) {
      const { x, y, say } = event.data.output;

      onPoint({ x, y });

      if (say) {
        text = say;
        onText(text);
      }
    }
  }

  return text;
}

// Ends the conversation, so the next question starts fresh and no longer
// carries what the previous one was about.
export function reset() {
  void session?.end();
  session = undefined;
}
