import { Client, type ClientSession } from "eve/client";

const client = new Client({
  baseUrl: import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:3001",
});

export type Control = { id: number; role: string; name: string };
export type Pointer = { elementId: number | null; caption: string };

let session: ClientSession | undefined;

// Tells a pointing result apart from any other tool output on the stream,
// which reports every call in the same shape.
const isPointer = (output: unknown): output is Pointer =>
  typeof output === "object" && output !== null && "elementId" in output;

// Reuses the open conversation or starts one, always attaching the screen as
// client context so that it lasts for this turn only.
async function deliver(question: string, elements: Control[]) {
  const clientContext = { elements };

  if (session) return session.send(question, { clientContext });

  const created = await client.sessions.create({
    message: question,
    clientContext,
  });

  session = created.session;

  return created.delivery;
}

// Asks the agent and calls back as soon as it picks a control, so the cursor
// can move before the written reply has finished.
export async function ask(
  question: string,
  elements: Control[],
  onPoint: (pointer: Pointer) => void,
) {
  const delivery = await deliver(question, elements);

  for await (const event of delivery.stream()) {
    if (event.type === "call.settled" && isPointer(event.data.output)) {
      onPoint(event.data.output);
    }
  }

  return delivery.result();
}

// Ends the conversation, so the next question starts fresh and no longer
// carries what the previous one was about.
export function reset() {
  void session?.end();
  session = undefined;
}
