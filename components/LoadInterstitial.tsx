import { css, type Component } from "dreamland/core";

const LoadInterstitial: Component<{ status: string }> = function () {
  return (
    <dialog class="signin">
      <div class="glass-content">
        <div class="logo-mark">
          <div class="logo-ring outer"></div>
          <div class="logo-ring inner"></div>
          <div class="logo-center"></div>
        </div>
        <h1>Scramjet</h1>
        <p class="status-text">{use(this.status)}</p>
        <div class="progress-track">
          <div class="progress-fill"></div>
        </div>
      </div>
    </dialog>
  );
};

LoadInterstitial.style = css`
  :scope {
    background: rgba(6, 12, 14, 0.72);
    backdrop-filter: blur(48px) saturate(200%);
    -webkit-backdrop-filter: blur(48px) saturate(200%);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-top: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 28px;
    width: 340px;
    padding: 0;
    box-shadow:
      0 0 0 1px rgba(0, 255, 136, 0.08),
      0 40px 100px rgba(0, 0, 0, 0.6),
      0 1px 0 rgba(255, 255, 255, 0.14) inset;
    color: #fff;
    text-align: center;
    font-family:
      -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  }

  .glass-content {
    padding: 44px 36px 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
  }

  /* Logo animation */
  .logo-mark {
    position: relative;
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .logo-ring {
    position: absolute;
    border-radius: 50%;
    border-style: solid;
    border-color: transparent;
  }

  .logo-ring.outer {
    inset: 0;
    border-width: 2px;
    border-top-color: var(--accent, #00ff88);
    border-right-color: rgba(0, 255, 136, 0.4);
    animation: spinCW 1.2s linear infinite;
  }

  .logo-ring.inner {
    inset: 8px;
    border-width: 2px;
    border-bottom-color: var(--accent, #00ff88);
    border-left-color: rgba(0, 255, 136, 0.3);
    animation: spinCCW 0.9s linear infinite;
  }

  .logo-center {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent, #00ff88);
    box-shadow: 0 0 16px var(--accent-glow, rgba(0, 255, 136, 0.5));
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes spinCW {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes spinCCW {
    to {
      transform: rotate(-360deg);
    }
  }

  @keyframes pulse {
    from {
      opacity: 1;
      transform: scale(1);
    }
    to {
      opacity: 0.6;
      transform: scale(0.8);
    }
  }

  h1 {
    font-size: 1.65rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0;
    background: linear-gradient(
      135deg,
      #fff 30%,
      var(--accent-text, #00ff88) 80%
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .status-text {
    font-size: 0.82rem;
    color: rgba(255, 255, 255, 0.45);
    line-height: 1.5;
    margin: 0;
    max-width: 240px;
    min-height: 1.2em;
  }

  .progress-track {
    width: 100%;
    height: 2px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 1px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    width: 40%;
    background: linear-gradient(
      90deg,
      transparent,
      var(--accent, #00ff88),
      transparent
    );
    border-radius: 1px;
    animation: progress 1.8s ease-in-out infinite;
  }

  @keyframes progress {
    from {
      transform: translateX(-150%);
    }
    to {
      transform: translateX(350%);
    }
  }

  :modal::backdrop {
    backdrop-filter: blur(8px);
    background: rgba(0, 0, 8, 0.55);
  }

  :modal[open] {
    animation: popIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) normal;
  }

  @keyframes popIn {
    from {
      opacity: 0;
      transform: scale(0.85) translateY(12px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
`;

export default LoadInterstitial;
