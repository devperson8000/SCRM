import { css, type Component } from "dreamland/core";
import { swapTransport } from "../index";
import {
  AVAILABLE_TRANSPORTS,
  type AvailableTransports,
  demoSettingsDefaults,
  demoSettingsStore,
  normalizeHomeUrl,
  normalizeMaxRequests,
  normalizeTransport,
  normalizeWispUrl,
  appearanceStore,
} from "../store";
import { THEMES, type ThemeId, applyTheme } from "../theme";

const SettingsView: Component<
  {},
  {
    wispUrl: string;
    transport: AvailableTransports;
    homeUrl: string;
    maxRequests: string;
    message: string;
    error: string;
  }
> = function () {
  this.wispUrl ??= demoSettingsStore.wispUrl;
  this.transport ??= demoSettingsStore.transport;
  this.homeUrl ??= demoSettingsStore.homeUrl;
  this.maxRequests ??= String(demoSettingsStore.maxRequests);
  this.message ??= "";
  this.error ??= "";

  const apply = async () => {
    this.message = "";
    this.error = "";
    try {
      const wispUrl = normalizeWispUrl(this.wispUrl);
      const transport = normalizeTransport(this.transport);
      const homeUrl = normalizeHomeUrl(this.homeUrl);
      const maxRequests = normalizeMaxRequests(this.maxRequests);
      const transportChanged =
        wispUrl !== demoSettingsStore.wispUrl ||
        transport !== demoSettingsStore.transport;

      demoSettingsStore.wispUrl = wispUrl;
      // Anything other than the environment's own default is the user's to
      // keep; store.ts only refreshes the URL on load while this is false.
      demoSettingsStore.wispUrlIsCustom =
        wispUrl !== demoSettingsDefaults.wispUrl;
      demoSettingsStore.transport = transport;
      demoSettingsStore.homeUrl = homeUrl;
      demoSettingsStore.maxRequests = maxRequests;
      this.wispUrl = wispUrl;
      this.homeUrl = homeUrl;
      this.maxRequests = String(maxRequests);
      if (transportChanged) {
        // Routed through index.tsx's single-flight swap rather than building a
        // transport here: that keeps a manual apply from racing an automatic
        // reconnect (both would have built one, and the loser's WebSocket has
        // no close() to reclaim it), and it moves the connection indicator
        // through reconnecting → online/offline like every other swap does.
        if (!(await swapTransport("settings changed", { probe: true }))) {
          this.error =
            "Settings saved, but the new transport could not connect. Check the wisp server URL.";

          return;
        }
      }
      this.message = "Settings saved.";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Invalid settings.";
    }
  };

  const reset = async () => {
    this.wispUrl = demoSettingsDefaults.wispUrl;
    this.transport = demoSettingsDefaults.transport;
    this.homeUrl = demoSettingsDefaults.homeUrl;
    this.maxRequests = String(demoSettingsDefaults.maxRequests);
    await apply();
  };

  return (
    <div class="settings-page">
      <div class="settings-heading">
        <span class="heading-icon ui-icon" aria-hidden="true">
          ⚙
        </span>
        <div>
          <span class="eyebrow">Preferences</span>
          <h2>Settings</h2>
          <p class="settings-intro">
            Shape your workspace and proxy connection.
          </p>
        </div>
      </div>

      <div class="settings-section">
        <div class="section-heading">
          <span class="ui-icon" aria-hidden="true">
            ◐
          </span>
          <div>
            <h3>Appearance</h3>
            <p>Theme and interface density</p>
          </div>
        </div>
        <label>
          <span>Theme</span>
          <select
            value={use(appearanceStore.theme)}
            on:change={(e: Event) => {
              const theme = (e.target as HTMLSelectElement).value as ThemeId;
              appearanceStore.theme = theme;
              applyTheme(theme);
            }}
          >
            {THEMES.map((theme) => (
              <option value={theme.id}>{theme.label}</option>
            ))}
          </select>
        </label>
        <label class="check-row">
          <span>RGB lighting</span>
          <input
            type="checkbox"
            checked={use(appearanceStore.rgbLighting)}
            on:change={(e: Event) => {
              appearanceStore.rgbLighting = (
                e.target as HTMLInputElement
              ).checked;
            }}
          />
        </label>
        <label class="check-row">
          <span>Matrix rain background</span>
          <input
            type="checkbox"
            checked={use(appearanceStore.matrixBg)}
            on:change={(e: Event) => {
              appearanceStore.matrixBg = (e.target as HTMLInputElement).checked;
            }}
          />
        </label>
        <label class="check-row">
          <span>Compact mode</span>
          <input
            type="checkbox"
            checked={use(appearanceStore.compactMode)}
            on:change={(e: Event) => {
              appearanceStore.compactMode = (
                e.target as HTMLInputElement
              ).checked;
            }}
          />
        </label>
      </div>

      <div class="settings-section connection-section">
        <div class="section-heading">
          <span class="ui-icon" aria-hidden="true">
            ◇
          </span>
          <div>
            <h3>Connection</h3>
            <p>Transport and session defaults</p>
          </div>
        </div>
        <label>
          <span>Wisp server</span>
          <input
            type="text"
            value={use(this.wispUrl)}
            spellcheck={false}
            on:input={(e: InputEvent) => {
              this.wispUrl = (e.target as HTMLInputElement).value;
            }}
          />
        </label>

        <label>
          <span>Transport</span>
          <select
            value={use(this.transport)}
            on:change={(e: Event) => {
              this.transport = (e.target as HTMLSelectElement)
                .value as AvailableTransports;
            }}
          >
            {AVAILABLE_TRANSPORTS.map((option) => (
              <option value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Home page URL</span>
          <input
            type="text"
            value={use(this.homeUrl)}
            spellcheck={false}
            on:input={(e: InputEvent) => {
              this.homeUrl = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
      </div>

      <label>
        <span>Request log limit</span>
        <input
          type="number"
          min="10"
          max="5000"
          step="10"
          value={use(this.maxRequests)}
          on:input={(e: InputEvent) => {
            this.maxRequests = (e.target as HTMLInputElement).value;
          }}
        />
      </label>

      <div class="actions">
        <button type="button" class="primary" on:click={apply}>
          Apply Settings
        </button>
        <button type="button" on:click={reset}>
          Reset Defaults
        </button>
      </div>

      {use(this.error).map((error) =>
        error ? <p class="message error">{error}</p> : null,
      )}
      {use(this.message).map((message) =>
        message ? <p class="message">{message}</p> : null,
      )}
    </div>
  );
};

SettingsView.style = css`
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
  .settings-page {
    width: min(820px, 100%);
    margin: 0 auto;
  }
  .settings-heading {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
  }
  .heading-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--accent-border, rgba(0, 255, 136, 0.35));
    border-radius: 8px;
    background: var(--accent-dim, rgba(0, 255, 136, 0.1));
    color: var(--accent-text, #00ff88);
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
  .settings-intro {
    margin: 4px 0 0;
    color: var(--text-3, #71847f);
    font-size: 0.82rem;
  }
  .settings-section {
    margin-bottom: 14px;
    padding: 20px;
    border: 1px solid var(--line, rgba(190, 230, 219, 0.12));
    border-radius: 8px;
    background: linear-gradient(
      145deg,
      rgba(20, 34, 37, 0.82),
      rgba(10, 18, 21, 0.88)
    );
  }
  .section-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line, rgba(190, 230, 219, 0.1));
  }
  .section-heading > .ui-icon {
    color: var(--accent-text, #00ff88);
    font-size: 19px;
    line-height: 1;
  }
  .settings-section h3 {
    margin: 0;
    color: var(--text-1, #eef7f4);
    font-size: 0.9rem;
  }
  .section-heading p {
    margin: 2px 0 0;
    color: var(--text-3, #71847f);
    font-size: 0.72rem;
  }
  .check-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 10px 0 0;
  }
  .check-row input {
    position: relative;
    width: 34px;
    height: 18px;
    appearance: none;
    border: 1px solid var(--line-strong, rgba(190, 230, 219, 0.2));
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
  }
  .check-row input::after {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-3, #71847f);
    content: "";
    transition:
      transform 150ms ease,
      background 150ms ease;
  }
  .check-row input:checked {
    border-color: var(--accent-border, rgba(0, 255, 136, 0.4));
    background: var(--accent-dim, rgba(0, 255, 136, 0.14));
  }
  .check-row input:checked::after {
    background: var(--accent, #00ff88);
    transform: translateX(16px);
  }
  label {
    display: block;
    margin: 0 0 14px;
  }
  label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2, #a7bab5);
    font-size: 0.78rem;
    font-weight: 620;
  }
  input,
  select {
    width: 100%;
    padding: 10px 11px;
    border: 1px solid var(--line-strong, rgba(190, 230, 219, 0.2));
    border-radius: 6px;
    background: rgba(3, 8, 10, 0.7);
    color: var(--text-1, #eef7f4);
    font: inherit;
    box-sizing: border-box;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent, #00ff88);
    box-shadow: 0 0 0 3px var(--accent-dim, rgba(0, 255, 136, 0.12));
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  button {
    padding: 9px 14px;
    border: 1px solid var(--line-strong, rgba(190, 230, 219, 0.2));
    border-radius: 6px;
    background: var(--surface-2, #0d171a);
    color: var(--text-2, #a7bab5);
    cursor: pointer;
    font: inherit;
  }
  button:hover {
    border-color: var(--accent-border, rgba(0, 255, 136, 0.35));
    color: var(--text-1, #eef7f4);
  }
  button.primary {
    border-color: var(--accent, #00ff88);
    background: var(--accent-dim, rgba(0, 255, 136, 0.12));
    color: var(--accent-text, #00ff88);
  }
  .message {
    margin-top: 16px;
    color: #00ff88;
  }
  .message.error {
    color: #ff8a8a;
  }
`;

export default SettingsView;
