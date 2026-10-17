import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyCapture,
  faceDistance,
  FACE_THRESHOLD,
} from "../api/_lib/face.ts";
import { demoFaceJpeg } from "./face-fixture.ts";

test("real fallback model enrolls a face missed by the fast detector and still separates a different face", async () => {
  const face = await demoFaceJpeg();
  const enrollment = await verifyCapture(Array(20).fill(face), "enroll");
  const login = await verifyCapture([face], "login");
  const other = await verifyCapture([await demoFaceJpeg(1)], "login");
  assert.ok(
    !Array.isArray(enrollment) &&
      !Array.isArray(login) &&
      !Array.isArray(other),
  );
  if (Array.isArray(enrollment) || Array.isArray(login) || Array.isArray(other))
    throw new Error("Expected verified capture metadata.");
  assert.ok(
    faceDistance(enrollment.descriptor, login.descriptor) < FACE_THRESHOLD,
  );
  assert.ok(
    faceDistance(enrollment.descriptor, other.descriptor) > FACE_THRESHOLD,
  );
  assert.ok(
    enrollment.reviewFrameIndex >= 0 && enrollment.reviewFrameIndex < 20,
  );
});
