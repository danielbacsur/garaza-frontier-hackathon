// A guided run played from a script instead of the agent, so that a demo can
// be recorded the same way every time. VITE_DEMO names a local server that
// hands out each step once the person has taken the one before.
export type DemoStep =
  | { think: true }
  | { x: number; y: number; say: string }
  | { say: string }
  | { done: true; say?: string };

const server = import.meta.env.VITE_DEMO as string | undefined;

export const demoing = Boolean(server);

// Waits for the next step, which the server holds back until it is due.
export async function nextStep(): Promise<DemoStep> {
  const response = await fetch(`${server}/next`);

  return response.json();
}
