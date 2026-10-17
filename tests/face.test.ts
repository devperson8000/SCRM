import test from "node:test";
import assert from "node:assert/strict";
import {
  faceDistance,
  decodeFrame,
  verifyCapture,
  selectConsistentTemplate,
  FaceCaptureError,
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
test("enrollment forms its template from twelve consistent faces without loosening identity distance", () => {
  const same = Array.from({ length: 12 }, (_, i) =>
    Array(128).fill(0.1 + i * 0.0001),
  );
  const foreign = Array.from({ length: 8 }, () => Array(128).fill(1));
  const result = selectConsistentTemplate([...same, ...foreign], 12);
  assert.ok(faceDistance(result.descriptor, same[0]) < 0.02);
  assert.ok(faceDistance(result.descriptor, foreign[0]) > 0.48);
  assert.throws(
    () => selectConsistentTemplate([...same.slice(0, 11), ...foreign], 12),
    FaceCaptureError,
  );
});
test("server validates scan purpose before inference and never accepts a single-photo enrollment", async () => {
  await assert.rejects(
    () => verifyCapture(["data:image/jpeg;base64,AAAA"], "enroll"),
    /Twenty/,
  );
  await assert.rejects(() => verifyCapture(Array(128).fill(0) as any, "login"));
});
