import { defineTool } from "eve/tools";
import { z } from "zod";

const Step = z.object({
  instruction: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "One action, such as one click, one choice or one entry, in one " +
        "short sentence.",
    ),
  done: z.boolean().describe("Whether the screen shows it is already done."),
});

const Plan = z.object({
  task: z
    .string()
    .max(200)
    .describe("What the user wants done, in a short sentence."),
  requirements: z
    .array(z.string().max(80))
    .max(10)
    .describe(
      "Every separate thing the user asked for, one each, such as each " +
        "setting to change. Every one needs steps of its own.",
    ),
  steps: z
    .array(Step)
    .max(30)
    .describe("One step for each single action, in order."),
});

export default defineTool({
  description:
    "Record the steps of a task that takes several, in order, marking the " +
    "ones the screen shows are done. Pass the complete plan on every call, " +
    "or an empty list of steps to drop it. Call it on its own, then point " +
    "at the first step that is not done.",

  inputSchema: Plan,

  outputSchema: Plan.extend({ remaining: z.number() }),

  // Counts what is left, which the desktop app uses to keep watching the
  // screen and the model uses to know when to say it is finished.
  async execute({ task, requirements, steps }) {
    const remaining = steps.filter((step) => !step.done).length;

    return { task, requirements, steps, remaining };
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
