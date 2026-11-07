import { defineChannel, OPTIONS, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { z } from "zod";

import { AUTH, ORIGINS } from "@/agent/lib/access";
import { next, Step } from "@/agent/lib/step";

const Request = z.object({
  picture: z.string().min(1),
  task: z.string(),
  steps: z.array(Step).min(1).max(20),
});

// Lets the desktop app's windows call this route from their own origin.
// Browsers ask first with a preflight request, answered the same way.
function allow(request: globalThis.Request, response: Response) {
  const origin = request.headers.get("origin");

  if (origin && ORIGINS.includes(origin)) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-methods", "POST");
    response.headers.set(
      "access-control-allow-headers",
      "authorization, content-type",
    );
  }

  return response;
}

export default defineChannel({
  routes: [
    OPTIONS("/step", async (request) =>
      allow(request, new Response(null, { status: 204 })),
    ),

    // Checks a planned task against a fresh screenshot without a turn of
    // the agent, which is what keeps each step down to a second or two.
    POST("/step", async (request) => {
      const auth = await routeAuth(request, AUTH);

      if (auth instanceof Response) return allow(request, auth);

      const parsed = Request.safeParse(await request.json());

      if (!parsed.success) {
        return allow(
          request,
          Response.json({ error: "bad request" }, { status: 400 }),
        );
      }

      const { picture, task, steps } = parsed.data;
      const outcome = await next(picture, task, steps, request.signal);

      return allow(request, Response.json(outcome));
    }),
  ],
});
