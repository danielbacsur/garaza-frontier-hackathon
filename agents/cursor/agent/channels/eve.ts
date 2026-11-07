import { eveChannel } from "eve/channels/eve";

import { AUTH, ORIGINS } from "@/agent/lib/access";

export default eveChannel({
  auth: AUTH,

  cors: {
    origin: ORIGINS,
    methods: ["GET", "POST"],
    allowHeaders: ["authorization", "content-type"],
  },
});
