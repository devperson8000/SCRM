import assert from "node:assert/strict";
import test from "node:test";

import {
  WISP_INIT_MAX_ATTEMPTS,
  wispInitRetryDelayMs,
} from "../connection-retry.ts";

test("minimum retry window covers a slow three-minute Render deployment", () => {
  const minimumRetryWindowMs = Array.from(
    { length: WISP_INIT_MAX_ATTEMPTS - 1 },
    (_, attempt) => wispInitRetryDelayMs(attempt, 0),
  ).reduce((total, delay) => total + delay, 0);

  assert.ok(
    minimumRetryWindowMs >= 180_000,
    `minimum retry window was only ${minimumRetryWindowMs}ms`,
  );
});

test("retry delay stays capped while the server is unavailable", () => {
  assert.equal(wispInitRetryDelayMs(20, 1), 10_000);
});
