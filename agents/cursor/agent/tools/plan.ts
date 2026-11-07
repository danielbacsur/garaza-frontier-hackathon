import { defineTool } from "eve/tools";
import { z } from "zod";

const Step = z.object({
  title: z.string().min(1).max(80).describe("One requirement, in plain words."),
  done: z.boolean().describe("Whether the screen shows it is already done."),
});

export default defineTool({
  description:
    "Record every requirement of a task that takes several steps, in order, " +
    "and mark the ones the screen shows are done. Pass the complete list on " +
    "every call, or an empty list to drop it. Call it on its own, then " +
    "point at or describe the next step.",

  inputSchema: z.object({ steps: z.array(Step).max(20) }),

  outputSchema: z.object({
    steps: z.array(Step),
    remaining: z.number(),
  }),

  // Counts what is left, which the desktop app uses to keep following the
  // task and the model uses to know when to say it is finished.
  async execute({ steps }) {
    return { steps, remaining: steps.filter((step) => !step.done).length };
  },

  // The list is already in the call's input, so the model only needs to be
  // told what comes next rather than given a second copy of every step.
  toModelOutput: ({ steps, remaining }) => ({
    type: "text",
    value: remaining
      ? `Steps left: ${remaining}. Guide the first one that is not done.`
      : steps.length
        ? "Every step is done. Tell the user in one short sentence."
        : "The plan is cleared.",
  }),
});
