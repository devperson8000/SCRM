import test from "node:test";
import assert from "node:assert/strict";
import {
  captureSize,
  assessFrame,
  encodeCameraFrame,
} from "../auth/capture-quality.ts";

test("portrait and wide cameras retain their aspect ratio without distortion", () => {
  assert.deepEqual(captureSize(480, 640), { width: 360, height: 480 });
  assert.deepEqual(captureSize(1280, 720), { width: 640, height: 360 });
  assert.deepEqual(captureSize(640, 480), { width: 640, height: 480 });
});
test("live quality guidance distinguishes missing, multiple, distant and off-center faces", () => {
  const image = { brightness: 120, sharpness: 100 };
  assert.equal(assessFrame(image, [], 640, 480).reason, "no-face");
  const box = { x: 200, y: 100, width: 220, height: 260 };
  assert.equal(assessFrame(image, [box], 640, 480).ready, true);
  assert.equal(
    assessFrame(image, [{ x: 100, y: -1, width: 300, height: 400 }], 640, 480)
      .ready,
    true,
  );
  assert.equal(
    assessFrame(image, [box, box], 640, 480).reason,
    "multiple-faces",
  );
  assert.equal(
    assessFrame(image, [{ ...box, width: 30, height: 40 }], 640, 480).reason,
    "too-small",
  );
  assert.equal(
    assessFrame(image, [{ ...box, x: -30 }], 640, 480).reason,
    "off-center",
  );
  assert.equal(
    assessFrame({ brightness: 12, sharpness: 100 }, [box], 640, 480).reason,
    "too-dark",
  );
});
test("JPEG encoding adapts quality to stay within the per-frame budget", () => {
  const calls: number[] = [];
  const canvas = {
    toDataURL(_type: string, q: number) {
      calls.push(q);
      return "data:image/jpeg;base64," + "a".repeat(q > 0.6 ? 130000 : 90000);
    },
  };
  const result = encodeCameraFrame(canvas);
  assert.ok(result.length <= 120000);
  assert.ok(calls.length > 1);
  assert.throws(() =>
    encodeCameraFrame({ toDataURL: () => "a".repeat(130000) }),
  );
});
