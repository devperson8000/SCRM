import { createStore, css, type Component } from "dreamland/core";
import type { ScramjetFlags } from "@mercuryworkshop/scramjet";
import { appScramjetFlags, FLAG_STORE_IDENT } from "../scramjet-flags";
import { cachePlugin, controller } from "../index";

const flagStore = createStore<ScramjetFlags>(
  {
    ...appScramjetFlags,
  },
  {
    ident: FLAG_STORE_IDENT,
    backing: "localstorage",
    autosave: "auto",
  },
);

const flagDescriptions: Record<keyof ScramjetFlags, string> = {
  syncxhr: "Enable synchronous XMLHttpRequest support",
  disableComputedWrap: "Skip deep JS interception for better runtime speed",
  cleanErrors: "Prevent sites from noticing scramjet stack frames",
  sourcemaps:
    "Prevent sites from noticing JS transformations (performance cost)",
  destructureRewrites: "Enable rewriting ES6 destructure syntax (experimental)",
  allowInvalidJs:
    "If invalid JS is evaluated, pass through unsafely instead of throwing",
  allowFailedIntercepts:
    "If an API interceptor fails, call with original input unsafely",
  encapsulateWorkers: "Wrap web workers in data URLs to prevent scope issues",
  scramitize: "Trigger debugger on 'scramjet' string detection (debug)",
  rewriterLogs: "Enable rewriter logging (debug)",
  captureErrors: "Capture and handle JavaScript errors (debug)",
  debugTrampolines: "Show proxied API in stack traces (debug)",
  debugSourceURL: "Make debugger recognize JS source URLs consistently (debug)",
};

const FlagEditor: Component<
  { inline?: boolean },
  {},
  { isOpen: boolean; cacheBustStatus: string }
> = function (cx) {
  this.isOpen = false;
  this.cacheBustStatus = "";

  const toggleFlag = (flag: keyof ScramjetFlags, value: boolean) => {
    flagStore[flag] = value;
    Object.assign(controller.scramjetConfig.flags, flagStore);
  };

  const resetToDefaults = () => {
    Object.assign(flagStore, { ...appScramjetFlags });
    Object.assign(controller.scramjetConfig.flags, flagStore);
  };

  const bustCache = async () => {
    this.cacheBustStatus = "Busting…";
    try {
      const ok = await cachePlugin.bust();
      this.cacheBustStatus = ok ? "✓ Cache cleared" : "Nothing to clear";
    } catch (err) {
      console.error("[FlagEditor] cache bust failed:", err);
      this.cacheBustStatus = "Bust failed";
    }
    setTimeout(() => {
      this.cacheBustStatus = "";
    }, 2500);
  };

  cx.mount = async () => {
    await controller.wait();
    Object.assign(controller.scramjetConfig.flags, flagStore);
  };

  return (
    <div
      class={use(this.inline).map(
        (inline) => `flag-editor ${inline ? "inline" : ""}`,
      )}
    >
      <button
        class="toggle-button"
        on:click={() => {
          this.isOpen = !this.isOpen;
          // The active browser tab's <iframe> is a separately composited
          // surface that Chromium paints above same-page content near it
          // regardless of z-index — a dropdown panel overlapping it renders
          // invisible underneath. Hiding the iframe while this panel is
          // open sidesteps that compositor quirk entirely.
          document.body.classList.toggle("flags-panel-open", this.isOpen);
        }}
      >
        <span class="material-symbols-outlined toggle-icon">flag</span>
        Flags
      </button>
      {use(this.isOpen).andThen(
        <div class="editor-panel">
          <div class="panel-header">
            <span class="panel-title">Feature Flags</span>
            <div class="header-actions">
              <button class="action-btn danger" on:click={bustCache}>
                Bust Cache
              </button>
              <button class="action-btn" on:click={resetToDefaults}>
                Reset
              </button>
            </div>
          </div>
          {use(this.cacheBustStatus).andThen(
            <div class="bust-status">{use(this.cacheBustStatus)}</div>,
          )}
          <div class="flags-list">
            {(Object.keys(flagStore) as Array<keyof ScramjetFlags>).map(
              (flag) => (
                <label class="flag-item">
                  <div class="toggle-wrap">
                    <input
                      type="checkbox"
                      checked={use(flagStore[flag])}
                      on:change={(e: Event) =>
                        toggleFlag(flag, (e.target as HTMLInputElement).checked)
                      }
                    />
                  </div>
                  <div class="flag-info">
                    <span class="flag-name">{flag}</span>
                    <span class="flag-desc">{flagDescriptions[flag]}</span>
                  </div>
                </label>
              ),
            )}
          </div>
        </div>,
      )}
    </div>
  );
};

FlagEditor.style = css`
  :scope {
    position: fixed;
    top: 1em;
    right: 1em;
    z-index: 1000;
    font-family: inherit;
    font-size: 13px;
  }

  :scope.inline {
    position: relative;
    display: flex;
    align-items: center;
    top: auto;
    right: auto;
  }

  .toggle-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 13px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-top: 1px solid rgba(255, 255, 255, 0.28);
    border-radius: 20px;
    color: rgba(255, 255, 255, 0.75);
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    font-family: inherit;
    line-height: 1.3;
    transition: all 0.15s ease;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.1) inset;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .toggle-button:hover {
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
    border-color: rgba(255, 255, 255, 0.28);
  }

  .material-symbols-outlined {
    font-family: "Material Symbols Outlined";
    font-weight: normal;
    font-style: normal;
    font-size: 14px !important;
    line-height: 1 !important;
    letter-spacing: normal;
    text-transform: none;
    display: inline-block;
    white-space: nowrap;
    direction: ltr;
    -webkit-font-smoothing: antialiased;
    font-variation-settings:
      "OPSZ" 20,
      "wght" 300,
      "FILL" 0,
      "GRAD" 0;
  }

  .toggle-icon {
    opacity: 0.8;
  }

  .editor-panel {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 340px;
    max-height: 65vh;
    overflow-y: auto;
    /* Solid background, no backdrop-filter: this panel can overlap the
       fullscreen browser-tab <iframe>, and Chromium's compositor loses that
       layering fight when a blurred/GPU-promoted element sits near an
       iframe — the iframe paints on top regardless of z-index. A solid
       background sidesteps the whole bug class. */
    background: rgb(8, 15, 18);
    border: 1px solid var(--line-strong, rgba(190, 230, 219, 0.2));
    border-radius: 8px;
    box-shadow:
      0 20px 60px rgba(0, 0, 0, 0.5),
      0 1px 0 rgba(255, 255, 255, 0.08) inset;
    z-index: 1001;
    color: #fff;
  }

  .editor-panel::-webkit-scrollbar {
    width: 5px;
  }
  .editor-panel::-webkit-scrollbar-track {
    background: transparent;
  }
  .editor-panel::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    position: sticky;
    top: 0;
    background: rgb(8, 15, 18);
    border-radius: 8px 8px 0 0;
  }

  .panel-title {
    font-size: 0.82rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.8);
    letter-spacing: 0.01em;
  }

  .header-actions {
    display: flex;
    gap: 6px;
  }

  .action-btn {
    padding: 4px 11px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 12px;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 0.74rem;
    font-family: inherit;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }

  .action-btn.danger {
    background: rgba(200, 50, 50, 0.2);
    border-color: rgba(220, 80, 80, 0.3);
    color: rgba(255, 160, 160, 0.9);
  }

  .action-btn.danger:hover {
    background: rgba(200, 50, 50, 0.35);
    color: #ffcaca;
  }

  .bust-status {
    padding: 6px 16px;
    font-size: 0.74rem;
    color: rgba(160, 255, 190, 0.8);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .flags-list {
    display: flex;
    flex-direction: column;
    padding: 8px;
    gap: 1px;
  }

  .flag-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    padding: 8px 10px;
    border-radius: 10px;
    transition: background 0.15s ease;
  }

  .flag-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .toggle-wrap {
    display: flex;
    align-items: center;
    padding-top: 1px;
    flex-shrink: 0;
  }

  .toggle-wrap input[type="checkbox"] {
    width: 15px;
    height: 15px;
    cursor: pointer;
    accent-color: var(--accent, #00ff88);
    flex-shrink: 0;
  }

  .flag-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .flag-name {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.78rem;
  }

  .flag-desc {
    font-size: 0.73rem;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.4;
  }
`;

export default FlagEditor;
