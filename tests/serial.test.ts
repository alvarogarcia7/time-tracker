// Overlapping syncs (open, reconnect, button) must not run at the same time.
import test from "node:test";
import assert from "node:assert/strict";

import { serialised } from "../src/core/serial";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("tasks started together run one at a time, in the order they were started", async () => {
  const queue = serialised();
  let running = 0;
  let most = 0;
  const order: string[] = [];
  const task = (name: string, ms: number) => async () => {
    running += 1;
    most = Math.max(most, running);
    order.push(`start ${name}`);
    await pause(ms);
    order.push(`end ${name}`);
    running -= 1;
    return name;
  };
  const results = await Promise.all([queue(task("open", 30)), queue(task("online", 5)), queue(task("button", 1))]);
  assert.deepEqual(results, ["open", "online", "button"]);
  assert.equal(most, 1);
  assert.deepEqual(order, ["start open", "end open", "start online", "end online", "start button", "end button"]);
});

test("a failing task does not stop the ones after it", async () => {
  const queue = serialised();
  const failed = queue(async () => {
    throw new Error("network down");
  });
  const next = queue(async () => "still runs");
  await assert.rejects(failed, /network down/);
  assert.equal(await next, "still runs");
});
