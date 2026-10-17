import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

export const FACE_THRESHOLD = 0.48;
export const FRAME_COUNT = 20;
export class FaceCaptureError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FaceCaptureError";
    this.code = code;
    this.status = status;
  }
}
export type VerifiedCapture = {
  descriptor: number[];
  reviewFrameIndex: number;
};
export type CaptureVerification = VerifiedCapture | number[];
export function selectConsistentTemplate(
  descriptors: number[][],
  minimum: number,
) {
  if (descriptors.length < minimum)
    throw new FaceCaptureError(
      "not_clear",
      "Not enough clear photos were found. Keep facing the camera in even lighting and retry.",
    );
  const distances = descriptors.map((a) =>
    descriptors.map((b) => faceDistance(a, b)),
  );
  const index = distances.reduce(
    (best, row, i) =>
      row.reduce((a, b) => a + b, 0) <
      distances[best].reduce((a, b) => a + b, 0)
        ? i
        : best,
    0,
  );
  const matching = descriptors.filter(
    (d) => faceDistance(descriptors[index], d) <= FACE_THRESHOLD,
  );
  if (matching.length < minimum)
    throw new FaceCaptureError(
      "inconsistent",
      "The photos did not consistently show the same face. Hold still in steady lighting and retry.",
    );
  return {
    descriptor: descriptors[index].map(
      (_, i) => matching.reduce((sum, d) => sum + d[i], 0) / matching.length,
    ),
    index,
  };
}
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

// No scripted yaw sequence: photos are sampled across naturally varied angles.

let loaded: Promise<any> | undefined;
let accurateLoaded: Promise<void> | undefined;
let modelDirectory = "";
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
      modelDirectory = modelPath;
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

// Serialize inference and bound waiting/work so a busy instance does not hang scans.
let queue: Promise<unknown> = Promise.resolve();
function frameTensor(face: any, value: string) {
  const image = decodeFrame(value);
  const rgb = new Int32Array(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4) {
    rgb[j++] = image.data[i];
    rgb[j++] = image.data[i + 1];
    rgb[j++] = image.data[i + 2];
  }
  return face.tf.tensor3d(rgb, [image.height, image.width, 3], "int32");
}
export async function verifyCapture(
  images: string[],
  purpose: string,
): Promise<CaptureVerification> {
  const expected =
    purpose === "login" ? 1 : purpose === "enroll" ? FRAME_COUNT : 0;
  if (!expected || !Array.isArray(images) || images.length !== expected)
    throw new FaceCaptureError(
      "invalid_capture",
      purpose === "login"
        ? "One clear login photo is required."
        : "Twenty enrollment photos are required.",
    );
  for (const image of images)
    if (
      typeof image !== "string" ||
      image.length > 120_000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    )
      throw new FaceCaptureError(
        "invalid_capture",
        "The camera sent an invalid photo. Reload the page and retry.",
      );
  const submitted = Date.now();
  const run = queue.then(async () => {
    if (Date.now() - submitted > 20000)
      throw new FaceCaptureError(
        "busy",
        "The face checker is busy. Please retry in a moment.",
        503,
      );
    let face: any;
    try {
      face = await loadModel();
    } catch (error) {
      console.error(
        "[auth] Face model failed to load:",
        error instanceof Error ? error.message : "Unknown model error",
      );
      throw new FaceCaptureError(
        "unavailable",
        "The face checker could not start. Ask the administrator to check the deployed models.",
        503,
      );
    }
    const candidates: { index: number; detection: any; quality: number }[] = [];
    let small = 0;
    const deadline = Date.now() + 35000;
    const checkTime = () => {
      if (Date.now() > deadline)
        throw new FaceCaptureError(
          "busy",
          "The face checker took too long. Please retry in a moment.",
          503,
        );
    };
    for (let index = 0; index < images.length; index++) {
      checkTime();
      let tensor: any;
      try {
        tensor = frameTensor(face, images[index]);
      } catch {
        throw new FaceCaptureError(
          "invalid_capture",
          "The camera photo could not be decoded. Reload and retry.",
        );
      }
      try {
        let detections = await face.detectAllFaces(
          tensor,
          new face.TinyFaceDetectorOptions({
            inputSize: 320,
            scoreThreshold: 0.4,
          }),
        );
        if (detections.length === 0) {
          accurateLoaded ??= face.nets.ssdMobilenetv1
            .loadFromDisk(modelDirectory)
            .catch((error: unknown) => {
              accurateLoaded = undefined;
              throw error;
            });
          await accurateLoaded;
          detections = await face.detectAllFaces(
            tensor,
            new face.SsdMobilenetv1Options({
              minConfidence: 0.5,
              maxResults: 3,
            }),
          );
        }
        if (detections.length > 1)
          throw new FaceCaptureError(
            "multiple_faces",
            "More than one face was detected. Please scan alone.",
          );
        if (!detections.length) continue;
        const detection = detections[0];
        if (detection.box.width < 45) {
          small++;
          continue;
        }
        candidates.push({
          index,
          detection,
          quality:
            detection.score *
            Math.min(detection.box.width, detection.box.height),
        });
      } finally {
        tensor.dispose();
      }
    }
    const minimum = purpose === "login" ? 1 : 12;
    if (candidates.length < minimum)
      throw new FaceCaptureError(
        "not_clear",
        small
          ? "Move a little closer so your face fills the guide."
          : "Your face was not clear enough in the photos. Face the camera directly with light in front of you.",
      );
    candidates.sort((a, b) => b.quality - a.quality);
    const descriptors: number[][] = [];
    for (let i = 0; i < candidates.length; i++) {
      checkTime();
      const candidate = candidates[i];
      const tensor = frameTensor(face, images[candidate.index]);
      try {
        // Reuse the detection; do not run the detector again during alignment.
        const result = await new face.DetectAllFaceLandmarksTask(
          Promise.resolve([{ detection: candidate.detection }]),
          tensor,
          false,
        ).withFaceDescriptors();
        descriptors.push(Array.from(result[0].descriptor));
      } finally {
        tensor.dispose();
      }
      if (descriptors.length >= minimum) {
        try {
          const selected = selectConsistentTemplate(descriptors, minimum);
          return {
            descriptor: selected.descriptor,
            reviewFrameIndex: candidates[selected.index].index,
          };
        } catch (error) {
          if (
            !(error instanceof FaceCaptureError) ||
            i === candidates.length - 1
          )
            throw error;
        }
      }
    }
    throw new FaceCaptureError(
      "not_clear",
      "Please keep one clear face in view and retry.",
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
