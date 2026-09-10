import { css, type Component } from "dreamland/core";
import { appearanceStore } from "../store";

const MatrixRain: Component<{}, {}, { canvas: HTMLCanvasElement }> = function (
  cx,
) {
  cx.mount = () => {
    const canvas = this.canvas;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let animationFrame = 0;
    let lastFrame = 0;
    let columns: number[] = [];
    let width = 0;
    let height = 0;
    const fontSize = 17;
    const characters = "01アイウエオカキクケコサシスセソ";
    let speeds: number[] = [];
    let trails: number[] = [];

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      columns = Array.from(
        { length: Math.ceil(width / fontSize) + 1 },
        () => Math.random() * -30,
      );
      speeds = columns.map(() => 0.2 + Math.random() * 0.35);
      trails = columns.map(() => 6 + Math.floor(Math.random() * 10));
    };

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    let running = false;

    const draw = (time: number) => {
      animationFrame = 0;
      if (!running) return;
      if (time - lastFrame < 48) {
        animationFrame = requestAnimationFrame(draw);
        return;
      }
      lastFrame = time;
      context.fillStyle = "rgba(3, 10, 12, 0.12)";
      context.fillRect(0, 0, width, height);
      context.font = `${fontSize}px ui-monospace, monospace`;
      for (let index = 0; index < columns.length; index++) {
        const x = index * fontSize;
        const head = columns[index] * fontSize;
        const trail = trails[index] ?? 10;
        for (let step = 0; step < trail; step++) {
          const y = head - step * fontSize;
          if (y < -fontSize || y > height + fontSize) continue;
          const fade = 1 - step / trail;
          context.fillStyle =
            step === 0
              ? "rgba(222, 255, 232, .96)"
              : `rgba(0, ${Math.floor(150 + fade * 105)}, ${Math.floor(45 + fade * 90)}, ${fade * 0.72})`;
          context.shadowColor = "#00ff88";
          context.shadowBlur = step === 0 ? 8 : 2;
          context.fillText(
            characters[Math.floor(Math.random() * characters.length)],
            x,
            y,
          );
        }
        context.shadowBlur = 0;
        if (head - trail * fontSize > height && Math.random() > 0.965)
          columns[index] = Math.random() * -24;
        columns[index] += speeds[index] ?? 0.7;
      }
      animationFrame = requestAnimationFrame(draw);
    };

    // The loop used to be unconditional: it ran for the whole life of the page
    // and repainted the entire viewport every ~48ms even with the effect turned
    // off, when the canvas is opacity:0 and nothing it drew was ever visible,
    // and it kept running while the tab was in the background. On a proxy whose
    // real work is rendering somebody else's site in an iframe, that is a
    // constant tax on the frame budget for nothing. Now the animation only runs
    // when it is switched on, visible, and not suppressed by reduced-motion.
    const shouldRun = () =>
      appearanceStore.matrixBg &&
      !motionQuery.matches &&
      document.visibilityState === "visible";

    const sync = () => {
      const next = shouldRun();
      if (next === running) return;
      running = next;
      if (running) {
        // Reset the throttle clock so the first frame after a resume paints
        // immediately instead of waiting out a stale timestamp.
        lastFrame = 0;
        animationFrame = requestAnimationFrame(draw);
      } else {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        // Leaving the last frame in the buffer means it fades back in on
        // resume, and it holds a full-viewport bitmap for no reason.
        context.clearRect(0, 0, width, height);
      }
    };

    resize();
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", sync);
    motionQuery.addEventListener("change", sync);
    use(appearanceStore.matrixBg).listen(sync);
    sync();

    // No teardown hook: dreamland's ComponentContext has no unmount callback
    // (`cx.cleanup`, which this used to assign, is never called by the
    // framework). This canvas is mounted once at the app root and lives as long
    // as the document, so the listeners above are page-lifetime by design.
  };

  return (
    <canvas
      aria-hidden="true"
      class={use(appearanceStore.matrixBg).map(
        (enabled) => `matrix-rain ${enabled ? "enabled" : ""}`,
      )}
      this={use(this.canvas)}
    />
  );
};

MatrixRain.style = css`
  :scope {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 240ms ease;
  }
  :scope.enabled {
    opacity: 0.34;
  }
`;

export default MatrixRain;
