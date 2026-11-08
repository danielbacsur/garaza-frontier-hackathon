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

// A task's steps, as the model writes them and as the desktop app keeps them.
export const Plan = z.object({
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

export const Recorded = Plan.extend({ remaining: z.number() });

// Counts the steps left, which the desktop app uses to keep watching the
// screen and to know when the task is finished.
export function record(plan: z.infer<typeof Plan>) {
  const remaining = plan.steps.filter((step) => !step.done).length;

  return { ...plan, remaining };
}
