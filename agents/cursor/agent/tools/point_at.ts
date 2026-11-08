import { defineTool } from "eve/tools";
import { z } from "zod";

const Fraction = z.number().min(0).max(1);

export default defineTool({
  description:
    "Point at a spot in the latest screenshot and say one line there. Give " +
    "the spot as fractions of the screenshot's width and height, from its " +
    "top left corner: 0 is the left or top edge and 1 the right or bottom " +
    "edge. The spot must be the very control the step needs; when that " +
    "control is not in the screenshot, give no spot at all and say where " +
    "to scroll or go instead. This ends your turn.",

  // The spot is the whole answer, so the turn ends here and spares a second
  // model call that would only repeat what was already said.
  endsTurn: true,

  inputSchema: z.object({
    x: Fraction.optional().describe("How far across the screenshot, 0 to 1."),
    y: Fraction.optional().describe("How far down the screenshot, 0 to 1."),
    say: z.string().min(1).describe("Your reply, shown in the speech bubble."),
    step: z
      .number()
      .int()
      .min(0)
      .describe(
        "The number of the task step this spot is for, 0 outside a task.",
      ),
  }),

  outputSchema: z.object({
    x: Fraction.nullable(),
    y: Fraction.nullable(),
    say: z.string(),
    step: z.number().nullable(),
  }),

  // Hands the spot back as given, since the desktop app knows where the
  // pictured window sits and places the second cursor there, or the words
  // alone when there was nothing in view to point at.
  async execute({ x, y, say, step }) {
    const spot = x !== undefined && y !== undefined;

    return { x: spot ? x : null, y: spot ? y : null, say, step: step || null };
  },
});
