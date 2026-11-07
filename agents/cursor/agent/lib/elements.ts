import { z } from "zod";

const screenSchema = z.object({
  elements: z.array(
    z.object({ id: z.number(), role: z.string(), name: z.string() }),
  ),
});

export type Element = z.infer<typeof screenSchema>["elements"][number];

type Message = { readonly role: string; readonly content: unknown };

// Collects the plain text of a message, whichever shape its content takes,
// because context can arrive as a string or as a list of parts.
const texts = ({ content }: Message): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) =>
    part.type === "text" ? [part.text as string] : [],
  );
};

// Finds the control list the desktop app sent with the current turn, newest
// message first, so an older screen is never mistaken for this one.
export const readElements = (messages: readonly Message[]): Element[] => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;

    for (const text of texts(message)) {
      const start = text.indexOf('{"elements"');
      if (start === -1) continue;

      try {
        const end = text.lastIndexOf("}") + 1;

        return screenSchema.parse(JSON.parse(text.slice(start, end))).elements;
      } catch {
        continue;
      }
    }
  }

  return [];
};

// Builds a readable choice key for a control, because descriptive keys picked
// far more reliably than numbered ones when the decision models were compared.
export const elementKey = ({ id, role, name }: Element) => {
  const label = `${role}_${name || "unnamed"}`;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);

  return `${slug}_${id}`;
};
