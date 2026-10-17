// Synthetic camera inputs cropped from the pinned recognition package's public
// demo image. No user photos or biometric records are committed as fixtures.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import jpeg from "jpeg-js";
const require = createRequire(import.meta.url);
export async function demoFace(which = 0) {
  const root = dirname(require.resolve("@vladmandic/face-api/package.json"));
  const image = jpeg.decode(await readFile(join(root, "demo/sample1.jpg")), {
    useTArray: true,
  });
  const box =
    which === 0
      ? { x: 768, y: 401, width: 305, height: 273 }
      : { x: 1434, y: 176, width: 337, height: 309 };
  const side = Math.ceil(Math.max(box.width, box.height) * 1.7);
  const x = Math.min(
    image.width - side,
    Math.max(0, Math.round(box.x + box.width / 2 - side / 2)),
  );
  const y = Math.min(
    image.height - side,
    Math.max(0, Math.round(box.y + box.height / 2 - side / 2)),
  );
  const pixels = Buffer.alloc(320 * 240 * 4);
  for (let cy = 0; cy < 240; cy++)
    for (let cx = 0; cx < 320; cx++) {
      const a =
          ((y + Math.floor((cy / 240) * side)) * image.width +
            x +
            Math.floor((cx / 320) * side)) *
          4,
        b = (cy * 320 + cx) * 4;
      for (let c = 0; c < 4; c++) pixels[b + c] = image.data[a + c];
    }
  return { width: 320, height: 240, data: pixels };
}
export async function demoFaceJpeg(which = 0) {
  return (
    "data:image/jpeg;base64," +
    jpeg.encode(await demoFace(which), 75).data.toString("base64")
  );
}
export async function cameraVideo() {
  const image = await demoFace();
  const { width: w, height: h, data } = image;
  const yuv = Buffer.alloc((w * h * 3) / 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4,
        r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      yuv[y * w + x] = Math.max(
        0,
        Math.min(255, Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b)),
      );
      if (x % 2 === 0 && y % 2 === 0) {
        const k = (y / 2) * (w / 2) + x / 2;
        yuv[w * h + k] = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b);
        yuv[w * h + (w * h) / 4 + k] = Math.round(
          128 + 0.439 * r - 0.368 * g - 0.071 * b,
        );
      }
    }
  return Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\nFRAME\n`),
    yuv,
  ]);
}
