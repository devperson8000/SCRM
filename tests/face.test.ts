import test from "node:test";
import assert from "node:assert/strict";
import {
  faceDistance,
  decodeFrame,
  verifyMotion,
  verifyCapture,
} from "../api/_lib/face.ts";
test("face distances require finite 128-dimensional server embeddings", () => {
  assert.equal(faceDistance(Array(128).fill(0), Array(128).fill(0)), 0);
  assert.throws(() => faceDistance([0], [0]));
  assert.throws(() => faceDistance(Array(128).fill(NaN), Array(128).fill(0)));
});
test("camera decoding rejects invalid, non-JPEG and oversized input", () => {
  for (const input of [
    "",
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,AAAA",
    "x".repeat(130000),
  ])
    assert.throws(() => decodeFrame(input));
});
test("server rejects a still image movement challenge and accepts ordered motion", () => {
  assert.throws(() => verifyMotion([0, 0, 0, 0, 0, 0], "left-right"));
  verifyMotion([0, 0, -0.25, -0.25, 0.25, 0.25], "left-right");
  assert.throws(() =>
    verifyMotion([0, 0, 0.25, 0.25, -0.25, -0.25], "left-right"),
  );
});
test("capture verifier rejects descriptors submitted instead of camera frames", async () => {
  await assert.rejects(() =>
    verifyCapture(Array(128).fill(0) as any, "left-right"),
  );
});
