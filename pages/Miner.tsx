import { css, type Component } from "dreamland/core";
import Monaco from "../components/Monaco";

type CloudMinerStatus = {
  running: boolean;
  configured: boolean;
  available: boolean;
  workers: number;
  pid: number | null;
  startedAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  logs: string[];
  note?: string | null;
};

const EMPTY_STATUS: CloudMinerStatus = {
  running: false,
  configured: false,
  available: true,
  workers: 1,
  pid: null,
  startedAt: null,
  lastExit: null,
  logs: [],
};

const DRAFT_KEY = "scrm-cloud-miner-python-draft-v1";

async function minerRequest(
  slot: 0 | 1,
  action: "status" | "source" | "start" | "stop",
): Promise<any> {
  const method = action === "start" || action === "stop" ? "POST" : "GET";
  const response = await fetch(
    `/api/miner-control?slot=${slot}&action=${action}`,
    {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body?.error ||
        body?.status?.error ||
        `Cloud miner request failed (HTTP ${response.status}).`,
    );
  }
  return body;
}

function displayUptime(startedAt: string | null): string {
  if (!startedAt) return "—";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const MinerView: Component<
  {},
  {},
  {
    miner0: CloudMinerStatus;
    miner1: CloudMinerStatus;
    source: string;
    canonicalSource: string;
    sourceLoading: boolean;
    action0: boolean;
    action1: boolean;
    message: string;
  }
> = function (cx) {
  this.miner0 ??= { ...EMPTY_STATUS };
  this.miner1 ??= { ...EMPTY_STATUS };
  this.source ??= localStorage.getItem(DRAFT_KEY) ?? "# Loading cloud miner source…";
  this.canonicalSource ??= "";
  this.sourceLoading ??= true;
  this.action0 ??= false;
  this.action1 ??= false;
  this.message ??= "";

  const setStatus = (slot: 0 | 1, status: CloudMinerStatus) => {
    if (slot === 0) this.miner0 = status;
    else this.miner1 = status;
  };

  const refreshSlot = async (slot: 0 | 1) => {
    try {
      const status = (await minerRequest(slot, "status")) as CloudMinerStatus;
      setStatus(slot, status);
    } catch (error) {
      const current = slot === 0 ? this.miner0 : this.miner1;
      setStatus(slot, {
        ...current,
        running: false,
        logs: [
          ...(current.logs ?? []).slice(-20),
          `[control] ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  };

  const refresh = async () => {
    await Promise.all([refreshSlot(0), refreshSlot(1)]);
  };

  const loadSource = async () => {
    this.sourceLoading = true;
    try {
      let body: any;
      try {
        body = await minerRequest(0, "source");
      } catch {
        body = await minerRequest(1, "source");
      }
      const canonical = String(body?.source ?? "");
      if (!canonical) throw new Error("Cloud miner source was empty.");
      this.canonicalSource = canonical;
      if (!localStorage.getItem(DRAFT_KEY)) this.source = canonical;
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : "Could not load miner source.";
    } finally {
      this.sourceLoading = false;
    }
  };

  const start = async (slot: 0 | 1) => {
    if (slot === 0) this.action0 = true;
    else this.action1 = true;
    this.message = "";
    try {
      const result = await minerRequest(slot, "start");
      setStatus(slot, result.status ?? result);
      this.message = `Cloud miner ${slot + 1} started on Northflank.`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (slot === 0) this.action0 = false;
      else this.action1 = false;
      void refreshSlot(slot);
    }
  };

  const stop = async (slot: 0 | 1) => {
    if (slot === 0) this.action0 = true;
    else this.action1 = true;
    this.message = "";
    try {
      const result = await minerRequest(slot, "stop");
      setStatus(slot, result.status ?? result);
      this.message = `Cloud miner ${slot + 1} stopped.`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (slot === 0) this.action0 = false;
      else this.action1 = false;
      window.setTimeout(() => void refreshSlot(slot), 350);
    }
  };

  cx.mount = () => {
    void loadSource();
    void refresh();
    window.setInterval(() => void refresh(), 2500);
  };

  const cloudCard = (
    slot: 0 | 1,
    title: string,
    subtitle: string,
  ) =>
    (slot === 0
      ? use(this.miner0, this.action0)
      : use(this.miner1, this.action1)
    ).map(([status, busy]: [CloudMinerStatus, boolean]) => (
      <article class={`cloud-card ${status.running ? "running" : ""}`}>
        <div class="cloud-card-head">
          <div>
            <div class="eyebrow">NORTHFLANK SLOT {slot + 1}</div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <span class={`status-pill ${status.running ? "online" : "offline"}`}>
            <span class="status-dot" />
            {status.running ? "Mining" : "Stopped"}
          </span>
        </div>

        <div class="miner-metrics">
          <div>
            <span>Process</span>
            <strong>{status.pid ? `PID ${status.pid}` : "—"}</strong>
          </div>
          <div>
            <span>Uptime</span>
            <strong>{displayUptime(status.startedAt)}</strong>
          </div>
          <div>
            <span>WISP workers</span>
            <strong>{status.workers ?? 1}</strong>
          </div>
          <div>
            <span>Key</span>
            <strong>{status.configured ? "Configured" : "Missing"}</strong>
          </div>
        </div>

        {status.note ? <div class="miner-warning">{status.note}</div> : null}
        {!status.configured ? (
          <div class="miner-warning">
            Add <code>KNX_API_KEY</code> to this Northflank service before starting it.
          </div>
        ) : null}

        <div class="cloud-actions">
          <button
            class="run-button"
            type="button"
            disabled={busy || status.running || !status.available || !status.configured}
            on:click={() => void start(slot)}
          >
            <span class="material-symbols-outlined" aria-hidden="true">
              cloud_upload
            </span>
            {busy && !status.running ? "Starting…" : "Run in cloud"}
          </button>
          <button
            class="stop-button"
            type="button"
            disabled={busy || !status.running}
            on:click={() => void stop(slot)}
          >
            <span class="material-symbols-outlined" aria-hidden="true">
              stop_circle
            </span>
            Stop
          </button>
          <button
            class="refresh-button"
            type="button"
            disabled={busy}
            title="Refresh miner status"
            on:click={() => void refreshSlot(slot)}
          >
            <span class="material-symbols-outlined" aria-hidden="true">
              refresh
            </span>
          </button>
        </div>

        <div class="log-shell">
          <div class="log-title">
            <span>Live output</span>
            <span>{status.logs?.length ?? 0} lines</span>
          </div>
          <pre>
            {(status.logs?.length ? status.logs : ["No miner output yet."]).join("\n")}
          </pre>
        </div>
      </article>
    ));

  return (
    <section class="miner-page">
      <header class="miner-hero">
        <div>
          <div class="eyebrow">KNXCOIN · CLOUD MINING</div>
          <h1>Two miners. Two WISP clouds.</h1>
          <p>
            Each Northflank WISP claims one KNX miner session, so both can mine
            the same wallet independently while respecting the two-miner limit.
          </p>
        </div>
        <div class="hero-badge">
          <span class="material-symbols-outlined" aria-hidden="true">
            memory
          </span>
          2 cloud slots
        </div>
      </header>

      {use(this.message).map((message) =>
        message ? (
          <div class="miner-message" role="status">
            {message}
          </div>
        ) : null,
      )}

      <div class="cloud-grid">
        {cloudCard(0, "SCRM-WISP", "Primary Northflank transport + miner")}
        {cloudCard(1, "SCRM-WISP-2", "Secondary Northflank transport + miner")}
      </div>

      <section class="editor-card">
        <div class="editor-top">
          <div>
            <div class="eyebrow">PYTHON EDITOR</div>
            <h2>cloud-miner.py</h2>
            <p>
              Your draft is saved locally. For security, “Run in cloud” executes
              the validated copy bundled into each WISP container rather than
              accepting arbitrary server-side Python from the browser.
            </p>
          </div>
          <div class="editor-actions">
            <span class="draft-state">
              {use(this.sourceLoading).map((loading) =>
                loading ? "Loading cloud copy…" : "Local draft",
              )}
            </span>
            <button
              type="button"
              class="reset-button"
              disabled={use(this.sourceLoading)}
              on:click={() => {
                if (!this.canonicalSource) return;
                this.source = this.canonicalSource;
                localStorage.removeItem(DRAFT_KEY);
                this.message = "Editor reset to the deployed cloud miner source.";
              }}
            >
              Reset to cloud copy
            </button>
          </div>
        </div>
        <div class="python-editor">
          <Monaco
            value={use(this.source)}
            language="python"
            readOnly={false}
            fill={true}
            onChange={(value) => {
              this.source = value;
              localStorage.setItem(DRAFT_KEY, value);
            }}
            onSave={() => {
              localStorage.setItem(DRAFT_KEY, this.source);
              this.message = "Python draft saved in this browser.";
            }}
          />
        </div>
      </section>
    </section>
  );
};

MinerView.style = css`
  :scope {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    flex-direction: column;
    gap: 18px;
    padding: 24px;
    background:
      radial-gradient(circle at 0 0, var(--accent-dim, rgba(0,255,136,.1)), transparent 28%),
      linear-gradient(180deg, rgba(4,10,10,.72), rgba(2,6,7,.92));
  }
  .miner-hero,
  .cloud-card,
  .editor-card {
    border: 1px solid rgba(190,255,230,.11);
    background: linear-gradient(145deg, rgba(13,27,24,.86), rgba(6,14,15,.9));
    box-shadow: 0 18px 50px rgba(0,0,0,.24), inset 0 1px rgba(255,255,255,.045);
    backdrop-filter: blur(20px);
  }
  .miner-hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 23px 25px;
    border-radius: 20px;
  }
  .eyebrow {
    color: var(--accent-text, #70ffb7);
    font-size: .61rem;
    font-weight: 850;
    letter-spacing: .16em;
  }
  h1, h2, p { margin: 0; }
  .miner-hero h1 {
    margin-top: 6px;
    color: #f5fff9;
    font-size: clamp(1.4rem, 2vw, 2.05rem);
    letter-spacing: -.035em;
  }
  .miner-hero p {
    max-width: 720px;
    margin-top: 8px;
    color: #93aaa1;
    font-size: .82rem;
    line-height: 1.55;
  }
  .hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    padding: 9px 12px;
    border: 1px solid var(--accent-border, rgba(0,255,136,.28));
    border-radius: 999px;
    color: var(--accent-text, #70ffb7);
    background: var(--accent-dim, rgba(0,255,136,.11));
    font-size: .72rem;
    font-weight: 750;
  }
  .hero-badge .material-symbols-outlined { font-size: 16px; }
  .miner-message {
    padding: 10px 13px;
    border: 1px solid rgba(112,255,183,.2);
    border-radius: 12px;
    color: #caffdf;
    background: rgba(0,255,136,.07);
    font-size: .74rem;
  }
  .cloud-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .cloud-card {
    min-width: 0;
    padding: 18px;
    border-radius: 18px;
    transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
  }
  .cloud-card.running {
    border-color: var(--accent-border, rgba(0,255,136,.3));
    box-shadow: 0 18px 52px rgba(0,0,0,.28), 0 0 28px var(--accent-glow, rgba(0,255,136,.08)), inset 0 1px rgba(255,255,255,.055);
  }
  .cloud-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }
  .cloud-card h2,
  .editor-card h2 {
    margin-top: 5px;
    color: #f1fff7;
    font-size: 1rem;
    letter-spacing: -.015em;
  }
  .cloud-card-head p,
  .editor-top p {
    margin-top: 5px;
    color: #758e85;
    font-size: .7rem;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    padding: 6px 9px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 999px;
    color: #82958e;
    background: rgba(255,255,255,.035);
    font-size: .64rem;
    font-weight: 750;
  }
  .status-pill.online {
    border-color: rgba(0,255,136,.24);
    color: #82ffc0;
    background: rgba(0,255,136,.08);
  }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #596760;
    box-shadow: 0 0 0 3px rgba(255,255,255,.03);
  }
  .status-pill.online .status-dot {
    background: #48f49b;
    box-shadow: 0 0 12px rgba(72,244,155,.65);
  }
  .miner-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-top: 16px;
  }
  .miner-metrics > div {
    min-width: 0;
    padding: 10px;
    border: 1px solid rgba(255,255,255,.055);
    border-radius: 11px;
    background: rgba(255,255,255,.025);
  }
  .miner-metrics span {
    display: block;
    color: #5f756d;
    font-size: .58rem;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .miner-metrics strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    color: #dff7ec;
    font-size: .71rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .miner-warning {
    margin-top: 10px;
    padding: 9px 10px;
    border: 1px solid rgba(255,191,105,.16);
    border-radius: 10px;
    color: #e8bd82;
    background: rgba(255,166,66,.055);
    font-size: .66rem;
    line-height: 1.45;
  }
  code {
    color: #c8ffdf;
    font-family: "SFMono-Regular", Consolas, monospace;
  }
  .cloud-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .cloud-actions button,
  .editor-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    border-radius: 10px;
    cursor: pointer;
    font: inherit;
    font-size: .69rem;
    font-weight: 750;
    transition: transform 150ms ease, border-color 150ms ease, background 150ms ease, opacity 150ms ease;
  }
  .cloud-actions button:disabled,
  .editor-actions button:disabled {
    cursor: not-allowed;
    opacity: .42;
  }
  .cloud-actions button:not(:disabled):hover,
  .editor-actions button:not(:disabled):hover { transform: translateY(-1px); }
  .run-button {
    padding: 7px 12px;
    border: 1px solid var(--accent-border, rgba(0,255,136,.34));
    color: #07130e;
    background: linear-gradient(145deg, #83ffc0, #48e996);
    box-shadow: 0 8px 22px rgba(0,255,136,.12);
  }
  .stop-button,
  .refresh-button,
  .reset-button {
    padding: 7px 11px;
    border: 1px solid rgba(255,255,255,.1);
    color: #afc2ba;
    background: rgba(255,255,255,.04);
  }
  .stop-button:not(:disabled):hover {
    border-color: rgba(255,114,114,.24);
    color: #ffaaaa;
    background: rgba(255,114,114,.07);
  }
  .refresh-button { width: 35px; padding: 0; margin-left: auto; }
  .cloud-actions .material-symbols-outlined { font-size: 15px; }
  .log-shell {
    margin-top: 14px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 12px;
    background: rgba(0,0,0,.24);
  }
  .log-title {
    display: flex;
    justify-content: space-between;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(255,255,255,.055);
    color: #647970;
    font-size: .58rem;
    font-weight: 720;
    text-transform: uppercase;
    letter-spacing: .07em;
  }
  pre {
    height: 150px;
    margin: 0;
    overflow: auto;
    padding: 10px;
    color: #88bba2;
    font: 10.5px/1.55 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .editor-card {
    display: flex;
    min-height: 520px;
    flex: 1 0 520px;
    overflow: hidden;
    flex-direction: column;
    border-radius: 18px;
  }
  .editor-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px;
    border-bottom: 1px solid rgba(255,255,255,.065);
  }
  .editor-top p {
    max-width: 720px;
    line-height: 1.45;
  }
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .draft-state {
    color: #6f857d;
    font-size: .63rem;
    white-space: nowrap;
  }
  .python-editor {
    min-height: 430px;
    flex: 1;
  }
  @media (max-width: 1000px) {
    .cloud-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 720px) {
    :scope { padding: 14px; }
    .miner-hero, .editor-top { flex-direction: column; align-items: stretch; }
    .hero-badge { align-self: flex-start; }
    .miner-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .editor-actions { justify-content: space-between; }
  }
`;

export default MinerView;
