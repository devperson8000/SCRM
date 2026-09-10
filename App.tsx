import { css, type Component } from "dreamland/core";
import FlagEditor from "./components/FlagEditor";
import MatrixRain from "./components/MatrixRain";
import ConnectionStatus from "./components/ConnectionStatus";
import BrowserView from "./pages/BrowserView";
import RequestViewer from "./pages/RequestViewer";
import PlaygroundView from "./pages/Playground";
import SettingsView from "./pages/SettingsPage";
import Dashboard from "./pages/Dashboard";
import {
  BrowserTabStrip,
  Omnibox,
  activateBrowserTab,
  browserState,
  closeBrowserTab,
  openBrowserTab,
} from "./pages/BrowserView";
import { requestsState } from "./pages/RequestViewer";
import { browserSessionState } from "./store";
import { cachePlugin, controller } from "./index";

type TabId = "browser" | "dashboard" | "requests" | "playground" | "settings";

const APP_TABS: Array<{
  id: TabId;
  label: string;
  icon: string;
}> = [
  { id: "browser", label: "Browser", icon: "◎" },
  { id: "dashboard", label: "Overview", icon: "▦" },
  { id: "requests", label: "Traffic", icon: "⇄" },
  { id: "playground", label: "Lab", icon: "{ }" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

const App: Component<{}, {}, { activeTab: TabId; modeMessage: string }> =
  function (cx) {
    this.activeTab ??= "browser";
    this.modeMessage ??= "";
    let normalCookieSnapshot: string | null = null;
    let modeChanging = false;

    const tabClass = (id: TabId) =>
      use(this.activeTab).map(
        (tab) => `tab-button ${tab === id ? "active" : ""}`,
      );

    const toggleIncognito = async () => {
      if (modeChanging) return;
      modeChanging = true;
      browserSessionState.incognito = !browserSessionState.incognito;
      requestsState.requests = [];
      this.modeMessage = browserSessionState.incognito
        ? "Private session enabled"
        : "Private session ended";
      try {
        await controller.wait();
        if (browserSessionState.incognito) {
          normalCookieSnapshot = controller.cookieJar.dump();
          controller.setCookiePersistence(false);
          controller.cookieJar.clear();
        } else {
          controller.cookieJar.clear();
          if (normalCookieSnapshot) {
            controller.cookieJar.load(normalCookieSnapshot);
          }
          controller.setCookiePersistence(true);
          await controller.persistCookies();
          normalCookieSnapshot = null;
        }
        await cachePlugin.bust();
      } catch (error) {
        console.warn(
          "[scramjet] unable to clear cache during mode change",
          error,
        );
      } finally {
        modeChanging = false;
      }
      window.setTimeout(() => (this.modeMessage = ""), 2600);
    };

    cx.mount = () => {
      const onKeyDown = (event: KeyboardEvent) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.key.toLowerCase() === "l") {
          event.preventDefault();
          this.activeTab = "browser";
          requestAnimationFrame(() => {
            const input = document.getElementById(
              "search",
            ) as HTMLInputElement | null;
            input?.focus();
            input?.select();
          });
        } else if (mod && event.key === ",") {
          event.preventDefault();
          this.activeTab = "settings";
        } else if (this.activeTab === "browser" && mod && event.key === "Tab") {
          event.preventDefault();
          const tabs = browserState.tabs;
          if (tabs.length < 2) return;
          const currentIndex = tabs.findIndex(
            (tab) => tab.id === browserState.activeTabId,
          );
          const nextIndex =
            (currentIndex + (event.shiftKey ? -1 : 1) + tabs.length) %
            tabs.length;
          activateBrowserTab(tabs[nextIndex].id);
        } else if (
          this.activeTab === "browser" &&
          mod &&
          event.key.toLowerCase() === "t"
        ) {
          event.preventDefault();
          openBrowserTab();
        } else if (
          this.activeTab === "browser" &&
          mod &&
          event.key.toLowerCase() === "w"
        ) {
          event.preventDefault();
          closeBrowserTab(browserState.activeTabId);
        } else if (mod && event.shiftKey && event.key.toLowerCase() === "d") {
          event.preventDefault();
          this.activeTab = "dashboard";
        } else if (mod && event.shiftKey && event.key.toLowerCase() === "p") {
          event.preventDefault();
          void toggleIncognito();
        }
      };
      document.addEventListener("keydown", onKeyDown);
      // Dead as written: dreamland's ComponentContext has no unmount hook, so
      // nothing ever calls this. Harmless here — the shell is mounted once for
      // the life of the page — but do not rely on it running.
      cx.cleanup = () => document.removeEventListener("keydown", onKeyDown);
    };

    return (
      <div class="app-shell">
        <MatrixRain />
        <div
          class={use(this.activeTab).map(
            (tab) =>
              `app-content ${tab === "browser" ? "browser-workspace" : ""}`,
          )}
        >
          <div class="top-bar">
            <div class="brand">
              <span class="brand-mark">
                <span class="ui-icon" aria-hidden="true">
                  ⚡
                </span>
              </span>
              <span class="brand-copy">
                <strong>Scramjet</strong>
                <small>
                  {use(browserSessionState.incognito).map((value) =>
                    value ? "PRIVATE" : "WORKSPACE",
                  )}
                </small>
              </span>
            </div>
            <div class="tab-bar">
              {APP_TABS.map((tab) => (
                <button
                  class={tabClass(tab.id)}
                  title={tab.label}
                  on:click={() => (this.activeTab = tab.id)}
                >
                  <span class="ui-icon" aria-hidden="true">
                    {tab.icon}
                  </span>
                  <span class="tab-label">{tab.label}</span>
                  {tab.id === "requests"
                    ? use(requestsState.requests).map((requests) =>
                        requests.length ? (
                          <span class="tab-count">{requests.length}</span>
                        ) : null,
                      )
                    : null}
                </button>
              ))}
            </div>
            {use(this.activeTab)
              .map((tab) => tab === "browser")
              .andThen(<Omnibox />)}
            <div class="top-actions">
              <ConnectionStatus />
              <button
                type="button"
                class={use(browserSessionState.incognito).map(
                  (value) => `mode-button ${value ? "active" : ""}`,
                )}
                title="Ctrl/Cmd + Shift + P"
                on:click={toggleIncognito}
              >
                <span class="material-symbols-outlined" aria-hidden="true">
                  visibility_off
                </span>
                <span>
                  {use(browserSessionState.incognito).map((value) =>
                    value ? "Private" : "Incognito",
                  )}
                </span>
              </button>
              <FlagEditor inline={true} />
            </div>
          </div>
          {use(this.modeMessage).map((message) =>
            message ? (
              <div class="mode-toast" role="status">
                {message}
              </div>
            ) : null,
          )}
          {use(this.activeTab).map((tab) =>
            tab === "browser" ? <BrowserTabStrip /> : null,
          )}

          <div
            class={use(this.activeTab).map(
              (tab) =>
                `tab-panel browser-panel-shell ${tab === "browser" ? "active" : ""}`,
            )}
          >
            <BrowserView
              active={use(this.activeTab).map((tab) => tab === "browser")}
            />
          </div>
          <div
            class={use(this.activeTab).map(
              (tab) => `tab-panel ${tab === "dashboard" ? "active" : ""}`,
            )}
          >
            <Dashboard />
          </div>
          <div
            class={use(this.activeTab).map(
              (tab) => `tab-panel ${tab === "requests" ? "active" : ""}`,
            )}
          >
            <RequestViewer
              active={use(this.activeTab).map((tab) => tab === "requests")}
            />
          </div>
          <div
            class={use(this.activeTab).map(
              (tab) => `tab-panel ${tab === "playground" ? "active" : ""}`,
            )}
          >
            <PlaygroundView
              active={use(this.activeTab).map((tab) => tab === "playground")}
            />
          </div>
          <div
            class={use(this.activeTab).map(
              (tab) => `tab-panel ${tab === "settings" ? "active" : ""}`,
            )}
          >
            <SettingsView />
          </div>
        </div>
      </div>
    );
  };

App.style = css`
  :scope {
    --surface-0: #05090b;
    --surface-1: #091013;
    --surface-2: #0d171a;
    --surface-3: #132125;
    --line: rgba(190, 230, 219, 0.12);
    --line-strong: rgba(190, 230, 219, 0.2);
    --text-1: #eef7f4;
    --text-2: #a7bab5;
    --text-3: #71847f;
    --danger: #ff7272;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: absolute;
    inset: 0;
    background:
      radial-gradient(
        circle at 12% 18%,
        rgba(0, 255, 136, 0.08),
        transparent 32%
      ),
      radial-gradient(
        circle at 88% 86%,
        rgba(0, 170, 255, 0.07),
        transparent 34%
      ),
      var(--surface-0);
    color: var(--text-1);
    font-family: "Aptos", "Segoe UI Variable", "Segoe UI", sans-serif;
  }
  .app-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .app-content.browser-workspace {
    height: 100%;
    overflow: hidden;
  }
  .browser-workspace .browser-panel-shell {
    display: flex;
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .top-bar {
    display: flex;
    align-items: stretch;
    min-height: 46px;
    background: linear-gradient(
      180deg,
      rgba(12, 22, 24, 0.98),
      rgba(7, 12, 15, 0.96)
    );
    border-bottom: 1px solid var(--line);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32);
    flex-shrink: 0;
    backdrop-filter: blur(18px);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 14px 0 11px;
    border-right: 1px solid var(--line);
    white-space: nowrap;
  }
  .brand strong {
    color: var(--text-1);
    font-size: 0.84rem;
    font-weight: 720;
  }
  .brand small {
    color: var(--text-3);
    font-size: 0.52rem;
    font-weight: 750;
    letter-spacing: 0.12em;
  }
  .brand-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .brand-mark {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    border: 1px solid var(--accent-border, rgba(0, 255, 136, 0.4));
    border-radius: 7px;
    background: var(--accent-dim, rgba(0, 255, 136, 0.12));
    color: var(--accent-text, #00ff88);
    box-shadow: 0 0 18px var(--accent-glow, rgba(0, 255, 136, 0.16));
  }
  .brand-mark .ui-icon {
    font-size: 17px;
  }
  .tab-bar {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 5px 6px;
  }
  .tab-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-3);
    padding: 6px 10px;
    border-radius: 7px;
    cursor: pointer;
    font: inherit;
    font-size: 0.82rem;
    white-space: nowrap;
    transition:
      color 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
  }
  .tab-button:hover {
    background: rgba(126, 255, 211, 0.1);
    color: #fff;
  }
  .tab-button.active {
    background: linear-gradient(
      180deg,
      rgba(126, 255, 211, 0.16),
      rgba(126, 255, 211, 0.08)
    );
    color: #fff;
    border-color: rgba(126, 255, 211, 0.28);
    box-shadow: 0 5px 18px rgba(0, 255, 136, 0.08);
  }
  .tab-button.active::after {
    position: absolute;
    right: 10px;
    bottom: -5px;
    left: 10px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--accent, #00ff88);
    box-shadow: 0 0 8px var(--accent-glow, rgba(0, 255, 136, 0.3));
    content: "";
  }
  .tab-button .ui-icon {
    display: inline-grid;
    min-width: 16px;
    place-items: center;
    font-size: 16px;
    font-weight: 650;
    line-height: 1;
  }
  .tab-count {
    min-width: 17px;
    padding: 1px 4px;
    border-radius: 5px;
    background: var(--accent-dim, rgba(0, 255, 136, 0.12));
    color: var(--accent-text, #00ff88);
    font-size: 0.62rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .top-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    padding: 0 12px;
  }
  .mode-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 9px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    color: #a9b6b8;
    cursor: pointer;
    font: inherit;
    font-size: 0.72rem;
    transition: all 160ms ease;
  }
  .mode-button:hover,
  .mode-button.active {
    border-color: var(--accent-border, rgba(0, 255, 136, 0.4));
    background: var(--accent-dim, rgba(0, 255, 136, 0.15));
    color: var(--accent-text, #00ff88);
  }
  .mode-button .material-symbols-outlined {
    font-size: 14px !important;
  }
  .mode-toast {
    position: fixed;
    top: 49px;
    left: 50%;
    z-index: 20;
    transform: translateX(-50%);
    padding: 8px 13px;
    border: 1px solid var(--accent-border, rgba(0, 255, 136, 0.4));
    border-radius: 999px;
    background: rgba(7, 17, 17, 0.94);
    color: var(--accent-text, #00ff88);
    font-size: 0.76rem;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  }
  .tab-panel {
    display: none;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .tab-panel.active {
    display: flex;
    animation: tab-panel-in 180ms ease;
  }
  @keyframes tab-panel-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-panel.active {
      animation: none;
    }
  }
  @media (max-width: 900px) {
    .brand small {
      display: none;
    }
    .tab-label {
      display: none;
    }
    .tab-button {
      padding-inline: 9px;
    }
    .mode-button span:last-child {
      display: none;
    }
  }
  @media (max-width: 620px) {
    .brand {
      padding-inline: 8px;
    }
    .brand-copy {
      display: none;
    }
    .tab-button {
      padding-inline: 7px;
    }
    .top-actions {
      gap: 3px;
      padding-inline: 4px;
    }
  }
`;

export default App;
