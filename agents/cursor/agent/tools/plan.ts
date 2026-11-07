import { defineTool } from "eve/tools";
import { z } from "zod";

import { Step } from "@/agent/lib/step";

const Plan = z.object({
  task: z
    .string()
    .max(200)
    .describe("What the user wants done, in a short sentence."),
  steps: z.array(Step).max(20),
});

export default defineTool({
  description:
    "Record every step of a task that takes several, in order, and mark the " +
    "ones the screen shows are done. Pass the complete plan on every call, " +
    "or an empty list of steps to drop it. Call it on its own, then point " +
    "at the first step that is not done.",

  inputSchema: Plan,

  outputSchema: Plan.extend({ remaining: z.number() }),

  // Counts what is left, which the desktop app uses to follow the task step
  // by step and the model uses to know when to say it is finished.
  async execute({ task, steps }) {
    const remaining = steps.filter((step) => !step.done).length;

    return { task, steps, remaining };
  },

  // The plan is already in the call's input, so the model only needs to be
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
