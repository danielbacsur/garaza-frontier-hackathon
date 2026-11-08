// A person's hand on the mouse, for a scripted browser: it glides along a slight curve, speeds up and
// settles (minimum jerk), overshoots a long reach and corrects, rests with a little drift, and presses
// a button for as long as a finger does. Everything it does is logged in record.swift's format, so a
// driven session renders exactly like a recorded one.

import { appendFileSync } from "node:fs";

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimum-jerk easing: how a hand's speed rises and falls over one reach. */
const ease = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

/**
 * @param {import("playwright-core").Page} page
 * @param {{ log: string, height: number, start?: { x: number, y: number } }} options
 *   log: the cursor.jsonl to append to; height: the viewport's, to flip y to bottom-left like AppKit.
 */
export function human(page, { log, height, start = { x: 720, y: 450 } }) {
  let x = start.x;
  let y = start.y;
  let down = 0;

  // The log samples the pointer 120 times a second whatever it is doing, as the recorder does, so a
  // rest counts as dwell just like a real one.
  const sampler = setInterval(() => {
    const line = { t: +(Date.now() / 1000).toFixed(4), x: +x.toFixed(1), y: +(height - y).toFixed(1), b: down };
    appendFileSync(log, JSON.stringify(line) + "\n");
  }, 1000 / 120);

  async function glide(tx, ty, ms) {
    const fx = x;
    const fy = y;
    const d = Math.hypot(tx - fx, ty - fy);
    // One bend, to one side, a little off the straight line.
    const bend = rand(0.06, 0.18) * d * (Math.random() < 0.5 ? -1 : 1);
    const cx = (fx + tx) / 2 + (-(ty - fy) / (d || 1)) * bend;
    const cy = (fy + ty) / 2 + ((tx - fx) / (d || 1)) * bend;
    const t0 = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - t0) / ms);
      const s = ease(t);
      x = (1 - s) * (1 - s) * fx + 2 * (1 - s) * s * cx + s * s * tx;
      y = (1 - s) * (1 - s) * fy + 2 * (1 - s) * s * cy + s * s * ty;
      await page.mouse.move(x, y);
      if (t >= 1) break;
      await sleep(8);
    }
  }

  const self = {
    get position() {
      return { x, y };
    },

    /** Reach for a point: longer reaches take longer (Fitts), and the long ones overshoot a touch. */
    async move(tx, ty) {
      const d = Math.hypot(tx - x, ty - y);
      if (d < 2) return;
      const ms = (180 + 110 * Math.log2(1 + d / 24)) * rand(0.85, 1.2);
      if (d > 280) {
        const over = rand(0.025, 0.05);
        await glide(tx + (tx - x) * over, ty + (ty - y) * over, ms);
        await glide(tx + rand(-1.5, 1.5), ty + rand(-1.5, 1.5), rand(110, 190));
      } else {
        await glide(tx + rand(-1.5, 1.5), ty + rand(-1.5, 1.5), ms);
      }
    },

    /** Rest on the spot, reading, with the slight drift of a hand that isn't moving. */
    async rest(ms) {
      const t0 = Date.now();
      const ox = x;
      const oy = y;
      while (Date.now() - t0 < ms) {
        x = ox + Math.sin((Date.now() - t0) / 420) * 1.2;
        y = oy + Math.cos((Date.now() - t0) / 530) * 0.9;
        await page.mouse.move(x, y);
        await sleep(40);
      }
    },

    /** Press and release where the pointer is. */
    async press() {
      down = 1;
      await page.mouse.down();
      await sleep(rand(70, 115));
      await page.mouse.up();
      down = 0;
    },

    /** Reach for an element (a locator) or a point, aim a little off its centre, settle and click. */
    async click(target, { aim = 0.18, settle = [120, 320], after = [250, 600] } = {}) {
      let tx;
      let ty;
      if (typeof target === "object" && "boundingBox" in target) {
        await target.waitFor({ state: "visible" });
        const box = await target.boundingBox();
        tx = box.x + box.width / 2 + rand(-aim, aim) * box.width;
        ty = box.y + box.height / 2 + rand(-aim, aim) * box.height;
      } else {
        ({ x: tx, y: ty } = target);
      }
      await self.move(tx, ty);
      await self.rest(rand(...settle));
      await self.press();
      await self.rest(rand(...after));
    },

    /** Type like a person, a key at a time. */
    async type(text) {
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep(rand(55, 130));
      }
    },

    stop() {
      clearInterval(sampler);
    },
  };

  return self;
}
