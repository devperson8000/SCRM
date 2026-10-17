import type { FaceBox } from "./capture-quality";
let loaded: Promise<any> | undefined;
let accurate: Promise<void> | undefined;
export async function createFaceGuide() {
  loaded ??= (async () => {
    const face: any = await import("@vladmandic/face-api/dist/face-api.esm.js");
    await face.tf.ready();
    await face.nets.tinyFaceDetector.loadFromUri("/face-detection");
    return face;
  })().catch((error) => {
    loaded = undefined;
    throw error;
  });
  const face = await loaded;
  return async (
    image: HTMLCanvasElement,
    useAccurate = false,
  ): Promise<FaceBox[]> => {
    if (useAccurate) {
      accurate ??= face.nets.ssdMobilenetv1
        .loadFromUri("/face-detection")
        .catch((error: unknown) => {
          accurate = undefined;
          throw error;
        });
      await accurate;
    }
    const options = useAccurate
      ? new face.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 3 })
      : new face.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.4,
        });
    const results = await face.detectAllFaces(image, options);
    return results.map((r: any) => ({
      x: r.box.x,
      y: r.box.y,
      width: r.box.width,
      height: r.box.height,
    }));
  };
}
