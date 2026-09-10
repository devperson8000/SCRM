import { css, type Component, createState } from "dreamland/core";
import {
  EventHandlerPlugin,
  LinkHandlerPlugin,
  UrlWatcherPlugin,
  LanguagePlugin,
} from "@mercuryworkshop/scramjet-utils";
import { versionInfo } from "@mercuryworkshop/scramjet";
import { cachePlugin, controller, languagePlugin } from "../index";
import { demoSettingsStore } from "../store";
import homepage from "./homepage.html?raw";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

function encodeDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function normalizeNavigationInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("Enter a URL or search term.");

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const looksLikeHostname = /^[^\s/?#]+\.[^\s/?#]+(?:[/?#]|$)/.test(trimmed);
  const withScheme = hasScheme
    ? trimmed
    : looksLikeHostname
      ? `https://${trimmed}`
      : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Only HTTP and HTTPS destinations are supported.");
  }
  return parsed.toString();
}

export type BrowserTabSnapshot = {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  error: string;
};

type BrowserTab = BrowserTabSnapshot & {
  frame: Frame;
  element: HTMLIFrameElement;
  navigationId: number;
  cleanup: () => void;
};

export const browserState = createState({
  tabs: [] as BrowserTabSnapshot[],
  activeTabId: "",
  url: demoSettingsStore.homeUrl,
  frame: null! as Frame,
  loading: true,
  error: "",
  navigationId: 0,
});

const browserTabs = new Map<string, BrowserTab>();
let createBrowserTab: ((url?: string) => void) | null = null;
let nextTabNumber = 1;

function setFrameVisibility(tab: BrowserTab, active: boolean) {
  tab.element.style.visibility = active ? "visible" : "hidden";
  tab.element.style.opacity = active ? "1" : "0";
  tab.element.style.pointerEvents = active ? "auto" : "none";
}

function syncBrowserState() {
  const active = browserTabs.get(browserState.activeTabId);
  browserState.tabs = [...browserTabs.values()].map(
    ({ id, title, url, loading, error }) => ({
      id,
      title,
      url,
      loading,
      error,
    }),
  );
  if (!active) return;
  browserState.url = active.url;
  browserState.frame = active.frame;
  browserState.loading = active.loading;
  browserState.error = active.error;
  browserState.navigationId = active.navigationId;
  const input = document.getElementById("search") as HTMLInputElement | null;
  if (input && document.activeElement !== input) input.value = active.url;
}

function getActiveBrowserTab() {
  return browserTabs.get(browserState.activeTabId);
}

function updateBrowserTab(tab: BrowserTab, patch: Partial<BrowserTab>) {
  Object.assign(tab, patch);
  syncBrowserState();
}

export function activateBrowserTab(id: string) {
  if (!browserTabs.has(id)) return;
  browserState.activeTabId = id;
  for (const tab of browserTabs.values()) {
    const active = tab.id === id;
    tab.element.classList.toggle("active", active);
    setFrameVisibility(tab, active);
  }
  syncBrowserState();
}

export function closeBrowserTab(id: string) {
  if (browserTabs.size <= 1) return;
  const tab = browserTabs.get(id);
  if (!tab) return;
  tab.cleanup();
  tab.element.remove();
  browserTabs.delete(id);
  if (browserState.activeTabId === id) {
    activateBrowserTab([...browserTabs.keys()][browserTabs.size - 1]);
  } else {
    syncBrowserState();
  }
}

export function openBrowserTab(url?: string) {
  createBrowserTab?.(url);
}

export function navigateBrowserTab(rawUrl: string) {
  const tab = getActiveBrowserTab();
  if (!tab) return;
  navigateTab(tab, rawUrl);
}

function navigateTab(tab: BrowserTab, rawUrl: string) {
  let nextUrl: string;
  try {
    nextUrl = normalizeNavigationInput(rawUrl);
  } catch {
    updateBrowserTab(tab, {
      loading: false,
      error: "That destination is not a valid HTTP(S) URL.",
    });
    return;
  }
  updateBrowserTab(tab, {
    url: nextUrl,
    title: tabTitle(nextUrl),
    loading: true,
    error: "",
    navigationId: tab.navigationId + 1,
  });
  try {
    tab.frame.go(nextUrl);
  } catch {
    updateBrowserTab(tab, {
      loading: false,
      error: "The proxy could not start this navigation.",
    });
    return;
  }
  const navigationId = tab.navigationId;
  window.setTimeout(() => {
    if (tab.navigationId !== navigationId || !tab.loading) return;
    updateBrowserTab(tab, {
      loading: false,
      error: "This page is taking longer than expected to respond.",
    });
  }, 20000);
}

function tabTitle(url: string) {
  // Deliberately *not* special-cased against demoSettingsStore.homeUrl. It
  // used to be, and since navigating also rewrote homeUrl to the destination,
  // every tab's title snapped back to "New tab" the moment its page loaded.
  // A tab showing the blank homepage gets its "New tab" title at creation
  // instead, where the fact is actually known.
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "New tab";
  } catch {
    return "New tab";
  }
}

function reloadCurrentPage() {
  const tab = getActiveBrowserTab();
  if (!tab) return;
  updateBrowserTab(tab, {
    loading: true,
    error: "",
    navigationId: tab.navigationId + 1,
  });
  tab.frame.go(tab.url);
}

export const Omnibox: Component<{}, { inputValue: string }> = function () {
  this.inputValue ??= browserState.url;

  const navigate = () => {
    let nextUrl: string;
    try {
      nextUrl = normalizeNavigationInput(this.inputValue);
    } catch (error) {
      browserState.error =
        error instanceof Error
          ? error.message
          : "That destination is not valid.";
      return;
    }
    this.inputValue = nextUrl;
    navigateBrowserTab(nextUrl);
  };
  return (
    <form
      class="url-form"
      on:submit={(e: SubmitEvent) => {
        e.preventDefault();
        navigate();
      }}
    >
      <div class="browser-omnibox-shell">
        <div class="omnibox-nav" aria-hidden="true">
          <button
            type="button"
            class="nav-btn"
            on:click={() => getActiveBrowserTab()?.frame.back()}
          >
            <span class="material-symbols-outlined">arrow_back</span>
          </button>
          <button
            type="button"
            class="nav-btn"
            on:click={() => getActiveBrowserTab()?.frame.forward()}
          >
            <span class="material-symbols-outlined">arrow_forward</span>
          </button>
          <button type="button" class="nav-btn" on:click={reloadCurrentPage}>
            <span class="material-symbols-outlined">refresh</span>
          </button>
        </div>
        <input
          id="search"
          class="url-input"
          type="text"
          value={use(this.inputValue)}
          spellcheck="false"
          placeholder="Enter URL or search..."
          on:input={(e: InputEvent) => {
            this.inputValue = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
    </form>
  );
};

export const BrowserTabStrip: Component = function () {
  return (
    <div class="browser-tab-strip" role="tablist" aria-label="Browser tabs">
      {use(browserState.tabs).map((tabs) => (
        <>
          {tabs.map((tab) => (
            <div
              class={`browser-tab ${tab.id === browserState.activeTabId ? "active" : ""}`}
              role="tab"
              aria-selected={tab.id === browserState.activeTabId}
              on:click={() => activateBrowserTab(tab.id)}
              title={tab.url}
            >
              <span
                class={
                  tab.loading ? "tab-loading-dot loading" : "tab-loading-dot"
                }
              ></span>
              <span class="browser-tab-title">{tab.title}</span>
              <button
                type="button"
                class="browser-tab-close"
                aria-label={`Close ${tab.title}`}
                on:click={(event: MouseEvent) => {
                  event.stopPropagation();
                  closeBrowserTab(tab.id);
                }}
              >
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
          ))}
        </>
      ))}
      <button
        type="button"
        class="browser-new-tab"
        aria-label="Open new browser tab"
        title="New tab"
        on:click={() => openBrowserTab()}
      >
        <span class="material-symbols-outlined">add</span>
      </button>
    </div>
  );
};

BrowserTabStrip.style = css`
  :scope {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    min-height: 35px;
    padding: 0.34rem 0.55rem 0;
    overflow-x: auto;
    background: linear-gradient(
      180deg,
      rgba(13, 25, 28, 0.96),
      rgba(7, 13, 16, 0.96)
    );
    border-bottom: 1px solid var(--line, rgba(143, 255, 218, 0.14));
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.05);
    scrollbar-width: thin;
  }
  .browser-tab {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 8.5rem;
    max-width: 15rem;
    height: 30px;
    padding: 0 0.38rem 0 0.62rem;
    border: 1px solid rgba(154, 255, 225, 0.08);
    border-bottom: 0;
    border-radius: 7px 7px 0 0;
    background: rgba(15, 29, 32, 0.52);
    color: #7f9998;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }
  .browser-tab:hover {
    background: rgba(31, 66, 66, 0.6);
    color: #c7e9df;
  }
  .browser-tab.active {
    background: var(--surface-3, rgba(28, 48, 51, 0.9));
    border-color: var(--accent-border, rgba(143, 255, 218, 0.25));
    color: #effff9;
    box-shadow: 0 -1px 16px rgba(68, 244, 187, 0.08);
  }
  .browser-tab-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.72rem;
    font-weight: 650;
  }
  .tab-loading-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 7px;
    border-radius: 50%;
    background: #58a18e;
    box-shadow: 0 0 0 2px rgba(88, 161, 142, 0.12);
  }
  .tab-loading-dot.loading {
    background: #a8ffdd;
    box-shadow: 0 0 10px #65ffc6;
    animation: tab-pulse 900ms ease-in-out infinite alternate;
  }
  .browser-tab-close,
  .browser-new-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #87a5a0;
    cursor: pointer;
  }
  .browser-tab-close:hover,
  .browser-new-tab:hover {
    background: rgba(196, 255, 233, 0.12);
    color: #effff9;
  }
  .browser-tab-close .material-symbols-outlined,
  .browser-new-tab .material-symbols-outlined {
    font-size: 15px !important;
  }
  .browser-new-tab {
    flex: 0 0 28px;
    margin: 0 0 3px 0.1rem;
    border: 1px solid rgba(143, 255, 218, 0.12);
    background: rgba(143, 255, 218, 0.05);
  }
  @keyframes tab-pulse {
    to {
      opacity: 0.35;
      transform: scale(0.7);
    }
  }
`;

Omnibox.style = css`
  :scope {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 1 1 auto;
    padding: 6px 10px;
  }
  .browser-omnibox-shell {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.4em;
    min-width: 0;
    flex: 1;
    padding: 0 0.35em;
    border-radius: 999px;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.06),
      rgba(255, 255, 255, 0.02)
    );
    border: 1px solid rgba(126, 255, 211, 0.16);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 8px 20px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      background 160ms ease;
  }
  .browser-omnibox-shell:focus-within {
    border-color: rgba(126, 255, 211, 0.45);
    background: linear-gradient(
      180deg,
      rgba(126, 255, 211, 0.1),
      rgba(126, 255, 211, 0.03)
    );
    box-shadow:
      0 0 0 3px rgba(0, 255, 136, 0.12),
      0 1px 0 rgba(255, 255, 255, 0.08) inset,
      0 8px 22px rgba(0, 0, 0, 0.26);
  }
  .omnibox-nav {
    display: flex;
    align-items: center;
    gap: 0.1em;
    padding-right: 0.3em;
    margin-right: 0.05em;
    border-right: 1px solid rgba(255, 255, 255, 0.1);
  }
  .nav-btn {
    border: 0;
    background: transparent;
    color: #9aa7aa;
    width: 1.7em;
    height: 1.7em;
    padding: 0;
    border-radius: 999px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      background 140ms ease,
      color 140ms ease;
  }
  .nav-btn:hover {
    background: rgba(0, 255, 136, 0.12);
    color: #7efed3;
  }
  .browser-omnibox-shell .material-symbols-outlined {
    font-size: 15px !important;
    line-height: 1 !important;
    font-variation-settings:
      "OPSZ" 20,
      "wght" 300,
      "FILL" 0,
      "GRAD" 0;
  }
  .url-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.4em 0.2em;
    font-size: 0.9em;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: #e9fbf4;
    outline: none;
  }
  .url-input::placeholder {
    color: #7b8a89;
  }
`;

const BrowserView: Component<
  { active: boolean },
  {},
  { root: HTMLDivElement; host: HTMLDivElement }
> = function (cx) {
  cx.mount = async () => {
    await controller.wait();
    this.root.style.position = "fixed";
    this.root.style.top = "81px";
    this.root.style.right = "0";
    this.root.style.bottom = "0";
    this.root.style.left = "0";
    this.root.style.width = "auto";
    this.root.style.height = "auto";
    this.root.style.maxWidth = "none";
    this.root.style.maxHeight = "none";
    this.root.style.minWidth = "0";
    this.root.style.minHeight = "0";
    this.root.style.overflow = "hidden";
    this.root.style.zIndex = "2";
    this.root.style.display = this.active ? "flex" : "none";
    this.host.style.position = "relative";
    this.host.style.display = "block";
    this.host.style.width = "100%";
    this.host.style.height = "100%";
    this.host.style.minWidth = "0";
    this.host.style.minHeight = "0";
    this.host.style.overflow = "hidden";
    let realHomepage = homepage;
    realHomepage = realHomepage.replaceAll(
      "{{SCRAMJET_VERSION}}",
      String(versionInfo.version),
    );
    realHomepage = realHomepage.replaceAll(
      "{{SCRAMJET_BUILD}}",
      String(versionInfo.build),
    );
    realHomepage = realHomepage.replaceAll(
      "{{SCRAMJET_DATE_PRETTY}}",
      new Date(versionInfo.date).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    );
    const homepageUrl = `data:text/html;base64,${encodeDataUrl(realHomepage)}`;

    const mountBrowserTab = async (requestedUrl?: string) => {
      const element = document.createElement("iframe");
      element.className = "browser-frame";
      element.title = "Scramjet browser tab";
      element.style.position = "fixed";
      element.style.top = "81px";
      element.style.right = "0";
      element.style.bottom = "0";
      element.style.left = "0";
      element.style.display = "block";
      element.style.width = "100vw";
      element.style.height = "calc(100vh - 81px)";
      element.style.minWidth = "100vw";
      element.style.minHeight = "calc(100vh - 81px)";
      element.style.border = "0";
      element.style.background = "white";
      element.style.zIndex = "3";
      element.style.visibility = "hidden";
      element.style.opacity = "0";
      element.style.pointerEvents = "none";
      element.style.transition = "opacity 160ms ease";
      // Keep frames outside the narrow flex host. The browser root is already
      // a fullscreen layer, and direct children inherit its app-level lifecycle.
      this.root.append(element);
      const id = `browser-tab-${nextTabNumber++}`;
      let initialUrl = demoSettingsStore.homeUrl;
      let initialError = "";
      if (requestedUrl) {
        try {
          initialUrl = normalizeNavigationInput(requestedUrl);
        } catch {
          initialError = "That destination is not a valid HTTP(S) URL.";
        }
      }
      let tab!: BrowserTab;
      const urlWatcher = new UrlWatcherPlugin((url) => {
        updateBrowserTab(tab, { url, title: tabTitle(url) });
      });
      const eventHandler = new EventHandlerPlugin({
        events: ["click", "auxclick"],
      });
      const linkHandler = new LinkHandlerPlugin((url) => openBrowserTab(url));
      const frame = controller.createFrame(element, {
        plugins: [
          cachePlugin,
          languagePlugin,
          eventHandler,
          linkHandler,
          urlWatcher,
        ],
      });
      tab = {
        id,
        title: requestedUrl ? tabTitle(initialUrl) : "New tab",
        url: initialUrl,
        frame,
        element,
        loading: Boolean(requestedUrl) && !initialError,
        error: initialError,
        navigationId: 0,
        cleanup: () => {},
      };
      browserTabs.set(id, tab);
      activateBrowserTab(id);
      const onLoad = () => updateBrowserTab(tab, { loading: false, error: "" });
      const onError = () =>
        updateBrowserTab(tab, {
          loading: false,
          error: "This page could not be loaded through the proxy.",
        });
      const onMessage = (event: MessageEvent) => {
        if (event.source !== element.contentWindow) return;
        if (
          event.data?.type !== "scramjet-navigate" ||
          typeof event.data.url !== "string"
        )
          return;
        navigateTab(tab, event.data.url);
      };
      element.addEventListener("load", onLoad);
      element.addEventListener("error", onError);
      window.addEventListener("message", onMessage);
      tab.cleanup = () => {
        element.removeEventListener("load", onLoad);
        element.removeEventListener("error", onError);
        window.removeEventListener("message", onMessage);
      };
      if (requestedUrl && !initialError) {
        navigateTab(tab, requestedUrl);
      } else if (!requestedUrl) {
        element.src = homepageUrl;
        updateBrowserTab(tab, { loading: false });
      }
    };
    createBrowserTab = (url) => {
      void mountBrowserTab(url);
    };
    const startupUrl =
      new URL(location.href).searchParams.get("goto") ?? undefined;
    await mountBrowserTab(startupUrl);
    history.replaceState(null, "", location.href.split("?")[0]);
    // Dead as written: dreamland's ComponentContext has no unmount hook, so
    // nothing ever calls this. Harmless here — App.tsx hides this panel with a
    // class rather than unmounting it — but do not rely on it running.
    cx.cleanup = () => {
      createBrowserTab = null;
      for (const tab of browserTabs.values()) {
        tab.cleanup();
        tab.element.remove();
      }
      browserTabs.clear();
    };
  };

  return (
    <div
      this={use(this.root)}
      class={use(this.active).map(
        (active) => `tab-panel browser-view ${active ? "active" : ""}`,
      )}
      style={use(this.active).map(
        (active) => `display:${active ? "flex" : "none"};`,
      )}
    >
      <div class="browser-frame-host" this={use(this.host)}></div>
      {use(browserState.loading).map((loading) =>
        loading ? (
          <div class="browser-status" role="status">
            <span class="status-spinner"></span>
            <span>Loading through Scramjet…</span>
          </div>
        ) : null,
      )}
      {use(browserState.error).map((error) =>
        error ? (
          <div class="browser-status error" role="alert">
            <strong>Unable to load page</strong>
            <span>{error}</span>
            <button
              type="button"
              on:click={() => {
                if (browserState.url) navigateBrowserTab(browserState.url);
              }}
            >
              Try again
            </button>
          </div>
        ) : null,
      )}
    </div>
  );
};

BrowserView.style = css`
  :scope {
    position: relative;
    flex: 1;
    flex-basis: 0;
    width: 100%;
    min-width: 0;
    min-height: 0;
    display: none;
    flex-direction: column;
    overflow: hidden;
  }
  :scope.active {
    display: flex;
    position: fixed;
    z-index: 2;
    top: 81px;
    right: 0;
    bottom: 0;
    left: 0;
    width: auto;
    height: auto;
    max-width: none;
  }

  .browser-frame-host {
    position: relative;
    display: flex;
    flex: 1;
    width: 100%;
    max-width: none;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: rgba(2, 7, 9, 0.7);
  }
  iframe {
    background: white;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease;
  }
  iframe.active {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }
  .browser-status {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 9px;
    transform: translate(-50%, -50%);
    padding: 11px 15px;
    border: 1px solid rgba(126, 255, 211, 0.2);
    border-radius: 999px;
    background: rgba(6, 15, 16, 0.9);
    color: #b7c5c5;
    font-size: 0.78rem;
    box-shadow: 0 16px 42px rgba(0, 0, 0, 0.32);
    pointer-events: none;
  }
  .browser-status.error {
    flex-direction: column;
    align-items: flex-start;
    border-radius: 12px;
    color: #ffb0b0;
    pointer-events: auto;
  }
  .browser-status.error span {
    color: #c79797;
  }
  .browser-status button {
    padding: 6px 10px;
    border: 1px solid rgba(255, 176, 176, 0.3);
    border-radius: 6px;
    background: rgba(255, 176, 176, 0.08);
    color: #ffb0b0;
    cursor: pointer;
    font: inherit;
  }
  .status-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(126, 255, 211, 0.22);
    border-top-color: var(--accent, #00ff88);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-spinner {
      animation: none;
    }
  }
`;

export default BrowserView;
