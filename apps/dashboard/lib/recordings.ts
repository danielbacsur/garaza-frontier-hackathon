import "server-only";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A recorded workflow, as tools/heatmap/render.sh writes it next to its GIF in public/heatmaps:
 * what was done, in which software, and what the cursor did along the way.
 */
export type Recording = {
  slug: string;
  title: string;
  app: string;
  recordedBy: string;
  recordedAt: string;
  durationSec: number;
  clicks: number;
  /** How far the cursor travelled, in screen points. */
  travel: number;
  /** The share of the screen the cursor ever came near, 0 to 1. */
  coverage: number;
  width: number;
  height: number;
  gif: string;
  poster: string;
};

const dir = path.join(process.cwd(), "public", "heatmaps");

/** Every recording in public/heatmaps, newest first. */
export async function recordings(): Promise<Recording[]> {
  const files = await readdir(dir).catch(() => []);
  const all = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8")) as Recording),
  );
  return all.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export const minutes = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
