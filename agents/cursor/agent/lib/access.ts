import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

// Who may talk to the agent, shared by every route it serves.
export const AUTH = [vercelOidc(), localDev(), placeholderAuth()];

// The desktop app's windows, while developing and once built.
export const ORIGINS = ["http://localhost:1420", "tauri://localhost"];
