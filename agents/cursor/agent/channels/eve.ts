import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [vercelOidc(), localDev(), placeholderAuth()],

  cors: {
    origin: ["http://localhost:1420", "tauri://localhost"],
    methods: ["GET", "POST"],
    allowHeaders: ["authorization", "content-type"],
  },
});
