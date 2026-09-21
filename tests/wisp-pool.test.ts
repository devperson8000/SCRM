import assert from "node:assert/strict";
import test from "node:test";

import { nextWispServerIndex, selectWispServerUrl } from "../wisp-pool.ts";

test("fresh startups alternate between two Wisp servers", () => {
  const first = nextWispServerIndex(null, 2);
  const second = nextWispServerIndex(String(first), 2);
  const third = nextWispServerIndex(String(second), 2);

  assert.deepEqual([first, second, third], [0, 1, 0]);
});

test("an invalid saved index safely restarts at the first server", () => {
  assert.equal(nextWispServerIndex("not-a-number", 2), 0);
});

test("server selection falls back to the available primary URL", () => {
  assert.equal(
    selectWispServerUrl(["wss://primary.example/wisp/"], "1"),
    "wss://primary.example/wisp/",
  );
});

test("server selection honors the requested alternating index", () => {
  const urls = ["wss://primary.example/wisp/", "wss://secondary.example/wisp/"];

  assert.equal(selectWispServerUrl(urls, "0"), urls[0]);
  assert.equal(selectWispServerUrl(urls, "1"), urls[1]);
});
