import { ENROLLMENT_PHOTOS, LOGIN_PHOTOS } from "./capture-policy";
import {
  captureSize,
  measureFrame,
  assessFrame,
  encodeCameraFrame,
  type FaceBox,
} from "./capture-quality";

/** Guidance runs locally; only the server can verify identity or grant access. */
export async function captureFace(
  host: HTMLElement,
  _instruction: string,
  signal: AbortSignal,
  singlePhoto = false,
): Promise<string[]> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Camera access needs HTTPS or localhost. Open this page in Chrome and allow camera access.",
    );
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const preview = document.createElement("div");
  preview.className = "face-preview";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.className = "face-video";
  const guide = document.createElement("div");
  guide.className = "face-guide";
  guide.setAttribute("aria-hidden", "true");
  preview.append(video, guide);
  const prompt = document.createElement("p");
  prompt.className = "face-prompt";
  prompt.setAttribute("aria-live", "polite");
  prompt.textContent = "Starting camera…";
  const progress = document.createElement("progress");
  progress.max = singlePhoto ? LOGIN_PHOTOS : ENROLLMENT_PHOTOS;
  progress.value = 0;
  progress.setAttribute("aria-label", "Clear photos captured");
  const note = document.createElement("p");
  note.className = "face-note";
  note.textContent =
    "Face the camera comfortably. You do not need to turn your head. Unclear frames are skipped automatically.";
  host.replaceChildren(preview, prompt, progress, note);
  let stream: MediaStream | undefined;
  const stop = () => {
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  const onPageHide = () => {
    stop();
  };
  window.addEventListener("pagehide", onPageHide, { once: true });
  signal.addEventListener("abort", stop, { once: true });
  const check = () => {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Cancelled", "AbortError"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: false,
      });
    } catch (error) {
      if ((error as Error).name === "NotAllowedError")
        throw new Error(
          "Camera permission was denied. In Chrome, open the site controls next to the address bar, allow Camera, then retry.",
        );
      if ((error as Error).name === "NotReadableError")
        throw new Error(
          "The camera is busy. Close other camera apps or tabs, then retry.",
        );
      if ((error as Error).name === "NotFoundError")
        throw new Error(
          "No camera was found. Connect a webcam or try a device with a camera.",
        );
      throw error;
    }
    check();
    video.srcObject = stream;
    const readyAt = performance.now();
    const play = video.play();
    play.catch(() => {});
    while (video.readyState < 2 || !video.videoWidth) {
      check();
      if (performance.now() - readyAt > 12000)
        throw new Error(
          "The camera did not start. Check camera permissions and retry.",
        );
      await wait(100);
    }
    const canvas = document.createElement("canvas");
    const size = captureSize(video.videoWidth, video.videoHeight);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Camera capture is unavailable.");
    let detect:
      | ((image: HTMLCanvasElement, accurate?: boolean) => Promise<FaceBox[]>)
      | undefined;
    let guidanceUnavailable = false;
    const basicGuidance = () => {
      guidanceUnavailable = true;
      detect = undefined;
      note.textContent =
        "Keep one face centered in good light. Basic camera checks are active; the server will verify your face.";
    };
    const guidance = import("./detector")
      .then((m) => m.createFaceGuide())
      .then((value) => {
        if (!guidanceUnavailable && !signal.aborted) detect = value;
      })
      .catch(basicGuidance);
    const images: string[] = [];
    let settled = 0;
    const started = performance.now();
    let missed = 0;
    let previousFrame = -1;
    let lastDetection = -Infinity;
    let latestFaces: FaceBox[] | undefined;
    while (images.length < progress.max) {
      check();
      if (performance.now() - started > 45000)
        throw new Error(
          "The camera could not get a clear view yet. Move closer, face a light, and retry.",
        );
      if (
        video.readyState < 2 ||
        !stream.getVideoTracks()[0] ||
        stream.getVideoTracks()[0].readyState === "ended"
      )
        throw new Error(
          "The camera stopped. Reconnect it or allow camera access, then retry.",
        );
      if (video.currentTime === previousFrame) {
        await wait(100);
        continue;
      }
      previousFrame = video.currentTime;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      let faces: FaceBox[] | undefined;
      if (detect) {
        if (performance.now() - lastDetection >= 750) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Guidance must not stall capture on devices with slow software graphics.
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Guidance unavailable")),
                3000,
              );
            });
            latestFaces = await Promise.race([
              detect(canvas, missed >= 4),
              timeout,
            ]);
            lastDetection = performance.now();
          } catch {
            basicGuidance();
            latestFaces = undefined;
          } finally {
            clearTimeout(timer);
          }
        }
        faces = latestFaces;
      }
      check();
      if (
        !detect &&
        !guidanceUnavailable &&
        performance.now() - started < 10000
      ) {
        prompt.textContent = "Loading face guidance…";
        await wait(150);
        continue;
      }
      if (!detect && !guidanceUnavailable) {
        basicGuidance();
      }
      // Inference may finish after the next video frame; encode a fresh frame.
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      previousFrame = video.currentTime;
      const quality = measureFrame(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width,
        canvas.height,
        faces?.[0],
      );
      const assessment = assessFrame(
        quality,
        faces,
        canvas.width,
        canvas.height,
      );
      if (!assessment.ready && faces?.length !== undefined && faces.length <= 1)
        missed++;
      preview.classList.toggle("face-ready", assessment.ready);
      if (!assessment.ready) {
        settled = 0;
        prompt.textContent = assessment.message;
        await wait(200);
        continue;
      }
      settled++;
      prompt.textContent =
        settled < 3
          ? faces
            ? "Face found. Hold still briefly…"
            : "Camera ready. Hold still briefly…"
          : `Capturing clear photo ${images.length + 1} of ${progress.max}…`;
      if (settled >= 3) {
        images.push(encodeCameraFrame(canvas));
        progress.value = images.length;
      }
      await wait(180);
    }
    // Keep a reference until load settles without leaving a rejected promise.
    void guidance;
    prompt.textContent = "Clear photos captured. Checking your face…";
    return images;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    window.removeEventListener("pagehide", onPageHide);
  }
}
