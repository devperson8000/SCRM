import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

export const FACE_THRESHOLD = 0.48;
export const FRAME_COUNT = 6;
const require = createRequire(import.meta.url);

export function faceDistance(a: number[], b: number[]): number {
  if (
    a.length !== 128 ||
    b.length !== 128 ||
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite)
  )
    throw new Error("Invalid face template.");
  return Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));
}

export function decodeFrame(value: string) {
  if (
    typeof value !== "string" ||
    value.length > 120_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error("Invalid camera image.");
  const bytes = Buffer.from(value.slice(23), "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("JPEG camera images are required.");
  const image = jpeg.decode(bytes, {
    useTArray: true,
    maxResolutionInMP: 0.35,
    maxMemoryUsageInMB: 32,
    tolerantDecoding: false,
  });
  if (
    image.width < 160 ||
    image.height < 120 ||
    image.width > 640 ||
    image.height > 480
  )
    throw new Error("Use camera images between 160×120 and 640×480.");
  return image;
}

export function verifyMotion(poses: number[], instruction: string) {
  if (
    poses.length !== FRAME_COUNT ||
    !poses.every(Number.isFinite) ||
    !["left-right", "right-left"].includes(instruction)
  )
    throw new Error("Invalid camera challenge.");
  const center = (poses[0] + poses[1]) / 2;
  const first = (poses[2] + poses[3]) / 2 - center;
  const second = (poses[4] + poses[5]) / 2 - center;
  const direction = instruction === "left-right" ? -1 : 1;
  if (
    Math.abs(center) > 0.36 ||
    first * direction < 0.075 ||
    second * direction > -0.075
  )
    throw new Error("Follow the head-turn instructions and try again.");
}

let loaded: Promise<any> | undefined;
async function loadModel() {
  if (!loaded)
    loaded = (async () => {
      const face = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      const wasm = require("@tensorflow/tfjs-backend-wasm");
      const staged = fileURLToPath(new URL("./face-assets/", import.meta.url));
      const hasStagedAssets = existsSync(join(staged, "model"));
      if (process.env.VERCEL === "1" && !hasStagedAssets)
        throw new Error(
          "Face assets are missing. Run pnpm auth:build before deployment.",
        );
      const wasmPath = hasStagedAssets
        ? join(staged, "wasm")
        : dirname(
            require.resolve(
              "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm",
            ),
          );
      const modelPath = hasStagedAssets
        ? join(staged, "model")
        : join(
            dirname(require.resolve("@vladmandic/face-api/package.json")),
            "model",
          );
      wasm.setWasmPaths(wasmPath + "/");
      await face.tf.setBackend("wasm");
      await face.tf.ready();
      const checksums = JSON.parse(
        await readFile(new URL("./face-models.json", import.meta.url), "utf8"),
      );
      for (const [file, expected] of Object.entries(checksums)) {
        const actual = createHash("sha256")
          .update(await readFile(join(modelPath, file)))
          .digest("hex");
        if (actual !== expected)
          throw new Error("Face model integrity verification failed.");
      }
      await face.nets.tinyFaceDetector.loadFromDisk(modelPath);
      await face.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await face.nets.faceRecognitionNet.loadFromDisk(modelPath);
      return face;
    })().catch((error) => {
      loaded = undefined;
      throw error;
    });
  return loaded;
}

// Serialize inference to bound CPU/memory use in an instance.
let queue: Promise<unknown> = Promise.resolve();
export async function verifyCapture(
  images: string[],
  instruction: string,
): Promise<number[]> {
  if (!Array.isArray(images) || images.length !== FRAME_COUNT)
    throw new Error("Six fresh camera images are required.");
  // Validate all payloads before loading the model or allocating tensors.
  const decoded = images.map(decodeFrame);
  const run = queue.then(async () => {
    const face = await loadModel();
    const descriptors: number[][] = [];
    const poses: number[] = [];
    for (const image of decoded) {
      const rgb = new Int32Array(image.width * image.height * 3);
      for (let i = 0, j = 0; i < image.data.length; i += 4) {
        rgb[j++] = image.data[i];
        rgb[j++] = image.data[i + 1];
        rgb[j++] = image.data[i + 2];
      }
      const tensor = face.tf.tensor3d(
        rgb,
        [image.height, image.width, 3],
        "int32",
      );
      try {
        const results = await face
          .detectAllFaces(
            tensor,
            new face.TinyFaceDetectorOptions({
              inputSize: 224,
              scoreThreshold: 0.6,
            }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors();
        if (results.length !== 1 || results[0].detection.box.width < 60)
          throw new Error(
            "Show exactly one well-lit face, closer to the camera.",
          );
        const result = results[0];
        descriptors.push(Array.from(result.descriptor));
        const nose = result.landmarks.getNose()[3];
        const left = result.landmarks.getLeftEye();
        const right = result.landmarks.getRightEye();
        const lx = left.reduce((s: number, p: any) => s + p.x, 0) / left.length;
        const rx =
          right.reduce((s: number, p: any) => s + p.x, 0) / right.length;
        poses.push((nose.x - (lx + rx) / 2) / Math.abs(rx - lx));
      } finally {
        tensor.dispose();
      }
    }
    verifyMotion(poses, instruction);
    if (
      descriptors.some((d) => faceDistance(descriptors[0], d) > FACE_THRESHOLD)
    )
      throw new Error("Keep the same face in view throughout the scan.");
    return descriptors[0].map(
      (_, i) => descriptors.reduce((s, d) => s + d[i], 0) / descriptors.length,
    );
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function benchmarkModel() {
  const start = performance.now();
  const face = await loadModel();
  const tensor = face.tf.zeros([240, 320, 3], "int32");
  try {
    const result = await face.detectAllFaces(
      tensor,
      new face.TinyFaceDetectorOptions({ inputSize: 224 }),
    );
    const descriptor =
      await face.nets.faceRecognitionNet.computeFaceDescriptor(tensor);
    return {
      backend: face.tf.getBackend(),
      elapsedMs: Math.round(performance.now() - start),
      facesOnBlankImage: result.length,
      descriptorDimensions: descriptor.length,
      memoryBytes: face.tf.memory().numBytes,
    };
  } finally {
    tensor.dispose();
  }
}
