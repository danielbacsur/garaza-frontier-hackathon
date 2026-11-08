import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  defaultTools: false,
  reasoning: "medium",

  // Turns can start on their own while a task is under way, each with a
  // screenshot, so a session that keeps going stops before it costs much.
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= 1_000_000 ||
      (window.costUsd ?? 0) >= 2,
  },
});
