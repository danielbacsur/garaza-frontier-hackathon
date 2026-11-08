import { defineTool } from "eve/tools";
import { z } from "zod";

import { Plan, Recorded, record } from "@/agent/lib/plan";

export default defineTool({
  description:
    "Change the plan of the task under way, or finish it with every step " +
    "marked done. Pass the complete plan, or an empty list of steps to drop " +
    "it. A new task's plan goes in point_at instead. This ends your turn.",

  // A changed plan comes with a pointer in the same step, or with words of
  // its own, so the turn ends here without another model call.
  endsTurn: true,

  inputSchema: Plan.extend({
    say: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Your reply when nothing is pointed at along with the plan, such " +
          "as one short sentence once every step is done.",
      ),
  }),

  outputSchema: Recorded.extend({ say: z.string().optional() }),

  // Hands the plan back counted, with the words for the bubble.
  async execute({ say, ...plan }) {
    return { ...record(plan), say };
  },
});
