// Drives a workflow in a real Chrome with a person's hand (human.mjs) and records it the way
// record.swift records a real session, so render.sh turns either into the same heatmap GIF.
//
//   node tools/heatmap/drive.mjs <workflow> <name> [url]
//
// <workflow> is a module in workflows/ exporting `run(page, hand, url)`. The recording lands in
// tools/heatmap/.recordings/<name>: screen.webm, cursor.jsonl and meta.json.

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { human } from "./human.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [workflow, name, url] = process.argv.slice(2);
if (!workflow || !name) {
  console.error("usage: node drive.mjs <workflow> <name> [url]");
  process.exit(64);
}

const { run } = await import(`./workflows/${workflow}.mjs`);
const out = path.join(here, ".recordings", name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const viewport = { width: 1440, height: 900 };

// A fresh, signed-out profile: nothing from anyone's own browser is used or shown.
const browser = await chromium.launch({ channel: "chrome", headless: false, args: [`--window-size=${viewport.width},${viewport.height + 90}`] });
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  locale: "en-US",
  recordVideo: { dir: out, size: viewport },
});

// The video starts with the page; its first frame is as close to now as the log can get.
const videoStart = Date.now() / 1000;
const page = await context.newPage();
const hand = human(page, { log: path.join(out, "cursor.jsonl"), height: viewport.height });

try {
  await run(page, hand, url);
} finally {
  hand.stop();
  await context.close();
  await browser.close();
}

const video = readdirSync(out).find((file) => file.endsWith(".webm"));
renameSync(path.join(out, video), path.join(out, "screen.webm"));
writeFileSync(
  path.join(out, "meta.json"),
  JSON.stringify(
    {
      videoStart,
      fps: 25,
      screen: { width: viewport.width, height: viewport.height, scale: 1 },
      recordedAt: new Date(videoStart * 1000).toISOString(),
      driven: true,
    },
    null,
    2,
  ),
);
console.log(`Saved to ${out}`);
