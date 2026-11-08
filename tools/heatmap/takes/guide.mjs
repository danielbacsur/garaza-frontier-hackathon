// Plays a guided take: the second cursor, running with VITE_DEMO=http://127.0.0.1:4546, is handed
// its steps from the script, and the real mouse takes each one, so the two stay in step however long
// a page takes to load.
//
//   node tools/heatmap/takes/guide.mjs <script.guide>
//
// Lines starting with "cursor" are for the second cursor:
//   cursor think                 it wiggles, thinking
//   cursor point X Y TEXT        it glides to a spot (screen points) and says TEXT
//   cursor say TEXT              it says TEXT beside the mouse
//   cursor done [TEXT]           it comes back beside the mouse, says TEXT in green, and fades
// Every other line is a hand command (see hand.swift), waited for before the next line.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = process.argv[2];
if (!script) {
  console.error("usage: node guide.mjs <script.guide>");
  process.exit(64);
}

// The cursor asks for its next step and waits; a step is answered as soon as one is asked for.
const steps = [];
let waiting;
function give(step) {
  if (waiting) {
    waiting(step);
    waiting = undefined;
  } else steps.push(step);
}
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url !== "/next") return response.writeHead(404).end();
  const answer = (step) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(step));
  if (steps.length) answer(steps.shift());
  else waiting = answer;
});
await new Promise((resolve) => server.listen(4546, "127.0.0.1", resolve));

const hand = spawn(path.join(here, "..", ".build", "hand"), ["-"], { stdio: ["pipe", "pipe", "inherit"] });
const acks = createInterface({ input: hand.stdout });
const done = [];
acks.on("line", (line) => line === "ok" && done.shift()?.());
const perform = (command) =>
  new Promise((resolve) => {
    done.push(resolve);
    hand.stdin.write(`${command}\n`);
  });

for (const raw of readFileSync(script, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [word, kind, ...rest] = line.split(" ");
  if (word !== "cursor") {
    await perform(line);
    continue;
  }
  if (kind === "think") give({ think: true });
  else if (kind === "done") give({ done: true, ...(rest.length && { say: rest.join(" ") }) });
  else if (kind === "say") give({ say: rest.join(" ") });
  else if (kind === "point") give({ x: Number(rest[0]), y: Number(rest[1]), say: rest.slice(2).join(" ") });
  console.log(line);
}

// The cursor is still waiting for a step that never comes.
hand.stdin.end();
server.closeAllConnections();
server.close();
