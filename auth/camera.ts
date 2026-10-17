/** Capture only after an explicit user gesture; always release camera tracks. */
export async function captureFace(
  host: HTMLElement,
  instruction: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Camera access requires HTTPS (or localhost) and a supported camera.",
    );
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.className = "face-video";
  const prompt = document.createElement("p");
  prompt.className = "face-prompt";
  prompt.setAttribute("aria-live", "polite");
  const warning = document.createElement("p");
  warning.className = "face-note";
  warning.textContent =
    "Keep one well-lit face in view. Follow the arrows in the camera preview.";
  host.replaceChildren(video, prompt, warning);
  let stream: MediaStream | undefined;
  const stop = () => {
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  const onPageHide = () => stop();
  window.addEventListener("pagehide", onPageHide, { once: true });
  signal.addEventListener("abort", stop, { once: true });
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
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        facingMode: "user",
      },
      audio: false,
    });
    if (signal.aborted) {
      stop();
      throw new DOMException("Cancelled", "AbortError");
    }
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera capture is unavailable.");
    const images: string[] = [];
    const first = instruction === "left-right" ? "LEFT ←" : "RIGHT →";
    const second = instruction === "left-right" ? "RIGHT →" : "LEFT ←";
    for (const message of [
      "Look straight into the camera",
      `Turn your head ${first} slightly and hold still. Keep both eyes visible.`,
      `Now turn your head ${second} slightly and hold still.`,
    ]) {
      prompt.textContent = message;
      await wait(2700);
      for (let i = 0; i < 2; i++) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        if (video.readyState < 2 || video.videoWidth === 0)
          throw new Error("Camera is not ready. Try again.");
        context.drawImage(video, 0, 0, 320, 240);
        images.push(canvas.toDataURL("image/jpeg", 0.75));
        await wait(350);
      }
    }
    prompt.textContent = "Checking your scan…";
    return images;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    window.removeEventListener("pagehide", onPageHide);
  }
}
