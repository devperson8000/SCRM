import { css, type Component, createState } from "dreamland/core";
import { versionInfo } from "@mercuryworkshop/scramjet";
import { demoSettingsStore } from "../store";
import { requestsState } from "./RequestViewer";
import { browserState } from "./BrowserView";

const dashboardState = createState({
  memUsed: 0,
  memLimit: 0,
  memSupported: false,
});

const refreshMemory = () => {
  // performance.memory sampling is only meaningful while the page is on
  // screen, and this runs on a 2.5s interval for the whole life of the tab.
  // Skipping it while hidden keeps a backgrounded proxy from being woken
  // twenty-four times a minute to update a panel nobody is looking at.
  if (document.visibilityState !== "visible") return;
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }
  ).memory;
  if (!memory) return;
  dashboardState.memUsed = Math.round(memory.usedJSHeapSize / 1024 / 1024);
  dashboardState.memLimit = Math.round(memory.jsHeapSizeLimit / 1024 / 1024);
  dashboardState.memSupported = true;
};

const Dashboard: Component = function (cx) {
  cx.mount = () => {
    refreshMemory();
    // Deliberately not cleared: dreamland's ComponentContext has no unmount
    // hook (the `cx.cleanup` that used to be assigned here was never called
    // by the framework), and this panel is mounted once for the life of the
    // page — App.tsx shows and hides it with a class, it never unmounts.
    setInterval(refreshMemory, 2500);
    document.addEventListener("visibilitychange", refreshMemory);
  };

  const requestCount = use(requestsState.requests).map(
    (requests) => requests.length,
  );
  const activeUrl = use(browserState.url);
  const memoryPercent = use(dashboardState.memUsed)
    .zip(use(dashboardState.memLimit))
    .map(([used, limit]) =>
      limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    );

  return (
    <div class="dashboard-page">
      <div class="dashboard-heading">
        <span class="heading-icon ui-icon" aria-hidden="true">
          ▦
        </span>
        <div>
          <span class="eyebrow">System overview</span>
          <h2>Workspace health</h2>
          <p>Live status for the proxy engine and this browser session.</p>
        </div>
      </div>

      <div class="dashboard-grid">
        <section class="dashboard-card">
          <div class="card-top">
            <span class="card-label">Engine</span>
            <span class="ui-icon" aria-hidden="true">
              ◈
            </span>
          </div>
          <strong>v{String(versionInfo.version)}</strong>
          <small>Build {String(versionInfo.build).slice(0, 7)}</small>
          <span class="status">
            <i></i> Active
          </span>
        </section>

        <section class="dashboard-card">
          <div class="card-top">
            <span class="card-label">Transport</span>
            <span class="ui-icon" aria-hidden="true">
              ⇄
            </span>
          </div>
          <strong>
            {use(demoSettingsStore.transport).map((transport) =>
              transport === "libcurl" ? "Libcurl" : "Epoxy",
            )}
          </strong>
          <small>{use(demoSettingsStore.wispUrl)}</small>
          <span class="status">
            <i></i> Connected
          </span>
        </section>

        <section class="dashboard-card">
          <div class="card-top">
            <span class="card-label">Active page</span>
            <span class="ui-icon" aria-hidden="true">
              ◎
            </span>
          </div>
          <strong class="truncate">{activeUrl}</strong>
          <small>Current browser destination</small>
        </section>

        <section class="dashboard-card">
          <div class="card-top">
            <span class="card-label">Requests</span>
            <span class="ui-icon" aria-hidden="true">
              ↔
            </span>
          </div>
          <strong>{requestCount}</strong>
          <small>Captured in this session</small>
        </section>

        {use(dashboardState.memSupported).map((supported) =>
          supported ? (
            <section class="dashboard-card">
              <div class="card-top">
                <span class="card-label">Memory</span>
                <span class="ui-icon" aria-hidden="true">
                  ◫
                </span>
              </div>
              <strong>{use(dashboardState.memUsed)} MB</strong>
              <small>of {use(dashboardState.memLimit)} MB heap limit</small>
              <div class="memory-track">
                <div
                  class="memory-fill"
                  style={memoryPercent.map((percent) => `width:${percent}%`)}
                ></div>
              </div>
            </section>
          ) : null,
        )}

        <section class="dashboard-card health-card">
          <div class="card-top">
            <span class="card-label">Platform support</span>
            <span class="ui-icon" aria-hidden="true">
              ✓
            </span>
          </div>
          <div class="health-row">
            <span>Service Worker</span>
            <b>{navigator.serviceWorker.controller ? "Active" : "Ready"}</b>
          </div>
          <div class="health-row">
            <span>Cache API</span>
            <b>{"caches" in window ? "Available" : "Unavailable"}</b>
          </div>
          <div class="health-row">
            <span>IndexedDB</span>
            <b>{"indexedDB" in window ? "Available" : "Unavailable"}</b>
          </div>
        </section>
      </div>
    </div>
  );
};

Dashboard.style = css`
  :scope {
    display: block;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: clamp(22px, 4vw, 48px);
    background: linear-gradient(
      145deg,
      rgba(10, 18, 21, 0.96),
      rgba(5, 9, 11, 0.98)
    );
    color: var(--text-1, #eef7f4);
    font-family: inherit;
  }
  .dashboard-page {
    width: min(1080px, 100%);
    margin: 0 auto;
  }
  .dashboard-heading {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 30px;
  }
  .heading-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--accent-border, rgba(0, 255, 136, 0.35));
    border-radius: 8px;
    background: var(--accent-dim, rgba(0, 255, 136, 0.1));
    color: var(--accent, #00ff88);
    font-size: 23px;
    box-shadow: 0 10px 28px var(--accent-glow, rgba(0, 255, 136, 0.08));
  }
  .eyebrow {
    display: block;
    margin-bottom: 3px;
    color: var(--accent-text, #00ff88);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 680;
  }
  p {
    margin: 4px 0 0;
    color: var(--text-3, #71847f);
    font-size: 0.82rem;
  }
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 12px;
  }
  .dashboard-card {
    display: flex;
    flex-direction: column;
    grid-column: span 4;
    gap: 8px;
    min-height: 144px;
    padding: 18px;
    border: 1px solid var(--line, rgba(190, 230, 219, 0.12));
    border-radius: 8px;
    background: linear-gradient(
      145deg,
      rgba(20, 34, 37, 0.82),
      rgba(10, 18, 21, 0.88)
    );
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
    transition:
      border-color 160ms ease,
      transform 160ms ease;
  }
  .dashboard-card:hover {
    border-color: var(--accent-border, rgba(0, 255, 136, 0.3));
    transform: translateY(-2px);
  }
  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .card-top .ui-icon {
    color: var(--text-3, #71847f);
    font-size: 18px;
    line-height: 1;
  }
  .card-label {
    color: var(--text-3, #71847f);
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .dashboard-card strong {
    color: var(--accent-text, #00ff88);
    font-size: 1.55rem;
    font-weight: 680;
  }
  .dashboard-card small {
    overflow: hidden;
    color: var(--text-3, #71847f);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
    color: var(--accent-text, #00ff88);
    font-size: 0.75rem;
  }
  .status i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent, #00ff88);
    box-shadow: 0 0 8px var(--accent-glow, rgba(0, 255, 136, 0.3));
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .memory-track {
    height: 5px;
    margin-top: auto;
    overflow: hidden;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.07);
  }
  .memory-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--accent, #00ff88);
    transition: width 0.4s ease;
  }
  .health-card {
    grid-column: span 8;
    gap: 10px;
  }
  .health-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-2, #a7bab5);
    font-size: 0.8rem;
  }
  .health-row b {
    color: var(--accent-text, #00ff88);
    font-weight: 500;
  }
  @media (max-width: 600px) {
    :scope {
      padding: 16px;
    }
  }
  @media (max-width: 840px) {
    .dashboard-card,
    .health-card {
      grid-column: span 6;
    }
  }
  @media (max-width: 560px) {
    .dashboard-card,
    .health-card {
      grid-column: 1 / -1;
    }
  }
`;

export default Dashboard;
