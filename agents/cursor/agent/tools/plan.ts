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
  say: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Your reply when nothing is pointed at along with the plan, such as " +
        "one short sentence once every step is done.",
    ),
});

export default defineTool({
  description:
    "Record the steps of a task that takes several, in order, marking the " +
    "ones the screen shows are done. Pass the complete plan on every call, " +
    "or an empty list of steps to drop it. Call it together with point_at " +
    "in the same step, or alone with say when there is nothing to point " +
    "at. This ends your turn.",

  // The plan and the pointer are made in one step, so the turn ends with
  // them and spares a second model call that would only repeat the plan.
  endsTurn: true,

  inputSchema: Plan,

  outputSchema: Plan.extend({ remaining: z.number() }),

  // Counts what is left, which the desktop app uses to keep watching the
  // screen and to know when the task is finished.
  async execute({ task, requirements, steps, say }) {
    const remaining = steps.filter((step) => !step.done).length;

    return { task, requirements, steps, say, remaining };
  },
});
