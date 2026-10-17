import { MAX_FRAME_CHARACTERS } from "./capture-policy.ts";
export type FaceBox = { x: number; y: number; width: number; height: number };
export type ImageQuality = { brightness: number; sharpness: number };
export function captureSize(width: number, height: number) {
  if (width <= 0 || height <= 0)
    throw new Error("The camera has not supplied a frame yet.");
  const scale = Math.min(1, 640 / width, 480 / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}
export function measureFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  face?: FaceBox,
): ImageQuality {
  const left = Math.max(2, Math.floor(face?.x ?? width * 0.2)),
    right = Math.min(
      width - 2,
      Math.ceil(face ? face.x + face.width : width * 0.8),
    );
  const top = Math.max(2, Math.floor(face?.y ?? height * 0.15)),
    bottom = Math.min(
      height - 2,
      Math.ceil(face ? face.y + face.height : height * 0.85),
    );
  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let brightness = 0,
    sharpness = 0,
    count = 0;
  for (let y = top; y < bottom; y += 3)
    for (let x = left; x < right; x += 3) {
      const value = gray(x, y);
      brightness += value;
      sharpness +=
        (4 * value -
          gray(x - 1, y) -
          gray(x + 1, y) -
          gray(x, y - 1) -
          gray(x, y + 1)) **
        2;
      count++;
    }
  return {
    brightness: count ? brightness / count : 0,
    sharpness: count ? sharpness / count : 0,
  };
}
export function assessFrame(
  quality: ImageQuality,
  faces: FaceBox[] | undefined,
  width: number,
  height: number,
) {
  const result = (reason: string, message: string, ready = false) => ({
    reason,
    message,
    ready,
  });
  if (quality.brightness < 32)
    return result(
      "too-dark",
      "Add light in front of you, rather than behind you.",
    );
  if (faces?.length === 0)
    return result(
      "no-face",
      "Look straight ahead and move your whole face into the guide.",
    );
  if (faces && faces.length > 1)
    return result("multiple-faces", "Only one person should be in view.");
  const face = faces?.[0];
  if (face) {
    if (face.width < width * 0.13 || face.height < height * 0.18)
      return result(
        "too-small",
        "Move a little closer so your face fills more of the guide.",
      );
    const cx = (face.x + face.width / 2) / width,
      cy = (face.y + face.height / 2) / height;
    if (
      face.x < -width * 0.05 ||
      face.y < -height * 0.05 ||
      face.x + face.width > width * 1.05 ||
      face.y + face.height > height * 1.05 ||
      cx < 0.2 ||
      cx > 0.8 ||
      cy < 0.15 ||
      cy > 0.85
    )
      return result("off-center", "Center your whole face inside the guide.");
  }
  if (quality.sharpness < 3)
    return result(
      "blurry",
      "Hold still for a moment while the camera focuses.",
    );
  return result(
    "ready",
    "Face ready. Hold comfortably still and look at the camera.",
    true,
  );
}
export function encodeCameraFrame(
  canvas: Pick<HTMLCanvasElement, "toDataURL">,
): string {
  for (const quality of [0.78, 0.68, 0.58, 0.48, 0.38]) {
    const image = canvas.toDataURL("image/jpeg", quality);
    if (image.length <= MAX_FRAME_CHARACTERS) return image;
  }
  throw new Error(
    "This camera image is too large. Try a lower camera resolution.",
  );
}
