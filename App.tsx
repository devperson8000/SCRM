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
  { id: "browser", label: "Browse", icon: "◎" },
  { id: "dashboard", label: "Overview", icon: "◫" },
  { id: "requests", label: "Traffic", icon: "↗" },
  { id: "playground", label: "Lab", icon: "⌘" },
  { id: "settings", label: "Settings", icon: "◇" },
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
                  S
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
    --surface-0: #030607;
    --surface-1: #07100f;
    --surface-2: #0a1715;
    --surface-3: #10211e;
    --line: rgba(183, 255, 225, 0.1);
    --line-strong: rgba(194, 255, 230, 0.2);
    --text-1: #f2fff9;
    --text-2: #a8bdb5;
    --text-3: #6f857d;
    --danger: #ff7272;
    position: absolute;
    inset: 0;
    display: flex;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    color: var(--text-1);
    background:
      radial-gradient(circle at 8% -10%, var(--accent-dim, rgba(0,255,136,.13)), transparent 34%),
      radial-gradient(circle at 92% 115%, rgba(41, 121, 255, .12), transparent 38%),
      linear-gradient(145deg, #030706 0%, #06100f 48%, #030809 100%);
    font-family: Inter, "SF Pro Display", "Segoe UI Variable", "Segoe UI", sans-serif;
    isolation: isolate;
  }
  :scope::before {
    position: fixed;
    inset: 0;
    z-index: 0;
    opacity: .2;
    pointer-events: none;
    background-image:
      linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: linear-gradient(to bottom, #000, transparent 82%);
    content: "";
  }
  .app-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
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
    position: relative;
    display: flex;
    align-items: stretch;
    min-height: 46px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(13,25,23,.94), rgba(5,11,12,.94));
    box-shadow:
      0 14px 38px rgba(0,0,0,.34),
      inset 0 1px rgba(255,255,255,.06);
    backdrop-filter: blur(26px) saturate(155%);
  }
  .top-bar::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 1px;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--accent-border, rgba(0,255,136,.38)), transparent);
    content: "";
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 142px;
    padding: 0 15px 0 11px;
    border-right: 1px solid var(--line);
    white-space: nowrap;
  }
  .brand-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .brand strong {
    color: #f5fff9;
    font-size: .84rem;
    font-weight: 760;
    letter-spacing: -.015em;
  }
  .brand small {
    color: var(--accent-text, #70ffb7);
    font-size: .49rem;
    font-weight: 800;
    letter-spacing: .16em;
  }
  .brand-mark {
    position: relative;
    display: grid;
    width: 29px;
    height: 29px;
    place-items: center;
    overflow: hidden;
    border: 1px solid var(--accent-border, rgba(0,255,136,.42));
    border-radius: 9px;
    color: #eafff3;
    background:
      linear-gradient(145deg, var(--accent-dim, rgba(0,255,136,.2)), rgba(255,255,255,.035));
    box-shadow:
      0 0 24px var(--accent-glow, rgba(0,255,136,.18)),
      inset 0 1px rgba(255,255,255,.16);
  }
  .brand-mark::after {
    position: absolute;
    inset: -40%;
    background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.34), transparent 65%);
    transform: translateX(-60%) rotate(8deg);
    animation: brand-sheen 6s ease-in-out infinite;
    content: "";
  }
  .brand-mark .ui-icon {
    z-index: 1;
    font-size: 14px;
    font-weight: 900;
  }
  @keyframes brand-sheen {
    0%, 70% { transform: translateX(-65%) rotate(8deg); }
    100% { transform: translateX(65%) rotate(8deg); }
  }
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 5px 7px;
  }
  .tab-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 6px 11px;
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--text-3);
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: .78rem;
    font-weight: 640;
    white-space: nowrap;
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease, transform 160ms ease;
  }
  .tab-button:hover {
    border-color: rgba(255,255,255,.075);
    color: #eafff5;
    background: rgba(255,255,255,.055);
    transform: translateY(-1px);
  }
  .tab-button.active {
    border-color: var(--accent-border, rgba(0,255,136,.28));
    color: #f4fff9;
    background: linear-gradient(145deg, var(--accent-dim, rgba(0,255,136,.16)), rgba(255,255,255,.035));
    box-shadow:
      0 8px 24px rgba(0,0,0,.2),
      inset 0 1px rgba(255,255,255,.08);
  }
  .tab-button.active::after {
    position: absolute;
    right: 12px;
    bottom: -6px;
    left: 12px;
    height: 2px;
    border-radius: 999px;
    background: var(--accent, #00ff88);
    box-shadow: 0 0 12px var(--accent-glow, rgba(0,255,136,.48));
    content: "";
  }
  .tab-button .ui-icon {
    display: inline-grid;
    min-width: 15px;
    place-items: center;
    color: currentColor;
    font-size: 15px;
    font-weight: 700;
    line-height: 1;
  }
  .tab-button.active .ui-icon { color: var(--accent-text, #70ffb7); }
  .tab-count {
    min-width: 18px;
    padding: 2px 5px;
    border: 1px solid var(--accent-border, rgba(0,255,136,.25));
    border-radius: 999px;
    color: var(--accent-text, #70ffb7);
    background: var(--accent-dim, rgba(0,255,136,.12));
    font-size: .59rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .top-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    padding: 0 11px 0 4px;
  }
  .mode-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid rgba(255,255,255,.11);
    border-radius: 999px;
    color: #91a59e;
    background: rgba(255,255,255,.035);
    cursor: pointer;
    font: inherit;
    font-size: .68rem;
    font-weight: 650;
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .mode-button:hover,
  .mode-button.active {
    border-color: var(--accent-border, rgba(0,255,136,.4));
    color: var(--accent-text, #70ffb7);
    background: var(--accent-dim, rgba(0,255,136,.13));
    box-shadow: 0 0 18px var(--accent-glow, rgba(0,255,136,.12));
  }
  .mode-button .material-symbols-outlined { font-size: 14px !important; }
  .mode-toast {
    position: fixed;
    top: 54px;
    left: 50%;
    z-index: 20;
    transform: translateX(-50%);
    padding: 9px 14px;
    border: 1px solid var(--accent-border, rgba(0,255,136,.4));
    border-radius: 999px;
    color: var(--accent-text, #70ffb7);
    background: rgba(5,14,13,.94);
    box-shadow: 0 16px 42px rgba(0,0,0,.4), inset 0 1px rgba(255,255,255,.08);
    backdrop-filter: blur(20px);
    font-size: .72rem;
    font-weight: 650;
  }
  .tab-panel {
    display: none;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .tab-panel.active {
    display: flex;
    animation: tab-panel-in 220ms cubic-bezier(.2,.8,.2,1);
  }
  @keyframes tab-panel-in {
    from { opacity: 0; transform: translateY(5px) scale(.998); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  button:focus-visible {
    outline: 2px solid var(--accent, #00ff88);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-panel.active, .brand-mark::after { animation: none; }
  }
  @media (max-width: 1080px) {
    .brand { min-width: auto; }
    .tab-label { display: none; }
    .tab-button { padding-inline: 10px; }
  }
  @media (max-width: 760px) {
    .brand { padding-inline: 8px; border-right: 0; }
    .brand-copy, .mode-button span:last-child { display: none; }
    .tab-bar { padding-inline: 2px; }
    .tab-button { padding-inline: 7px; }
    .top-actions { gap: 3px; padding-right: 5px; }
  }
`

export default App;
