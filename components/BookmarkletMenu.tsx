import { css, type Component } from "dreamland/core";
import {
  type Bookmarklet,
  normalizeBookmarkletCode,
  parseStoredBookmarklets,
} from "../bookmarklets";

const STORAGE_KEY = "scramjet-bookmarklets-v1";
const DEFAULT_BOOKMARKLETS: Bookmarklet[] = [
  {
    id: "highlight-links",
    name: "Highlight links",
    code: "document.querySelectorAll('a').forEach((link) => { link.style.outline = '2px solid #00ff88'; });",
  },
];

const BookmarkletMenu: Component<
  { onRun: (code: string) => void },
  {},
  {
    open: boolean;
    items: Bookmarklet[];
    name: string;
    code: string;
    editingId: string;
    message: string;
  }
> = function () {
  this.open ??= false;
  const stored = localStorage.getItem(STORAGE_KEY);
  this.items ??=
    stored === null ? DEFAULT_BOOKMARKLETS : parseStoredBookmarklets(stored);
  this.name ??= "";
  this.code ??= "";
  this.editingId ??= "";
  this.message ??= "";

  const persist = (items: Bookmarklet[]) => {
    this.items = items;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  };

  const clearEditor = () => {
    this.name = "";
    this.code = "";
    this.editingId = "";
  };

  const save = () => {
    const name = this.name.trim();
    if (!name) {
      this.message = "Give the bookmarklet a name.";
      return;
    }
    try {
      const code = normalizeBookmarkletCode(this.code);
      const id = this.editingId || crypto.randomUUID();
      const next = this.editingId
        ? this.items.map((item) => (item.id === id ? { id, name, code } : item))
        : [...this.items, { id, name, code }];
      persist(next);
      clearEditor();
      this.message = "Bookmarklet saved.";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : "Invalid bookmarklet.";
    }
  };

  const run = (item: Bookmarklet) => {
    try {
      this.onRun(item.code);
      this.message = `Ran ${item.name} in the active tab.`;
      this.open = false;
    } catch (error) {
      this.message =
        error instanceof Error
          ? error.message
          : "The bookmarklet could not run.";
    }
  };

  return (
    <div class="bookmarklet-menu">
      <button
        type="button"
        class={use(this.open).map(
          (open) => `bookmarklet-trigger ${open ? "active" : ""}`,
        )}
        title="JavaScript bookmarklets"
        aria-expanded={use(this.open)}
        on:click={() => {
          this.open = !this.open;
          this.message = "";
        }}
      >
        <span class="material-symbols-outlined" aria-hidden="true">
          bookmark
        </span>
        <span>Bookmarklets</span>
      </button>
      {use(this.open).map((open) =>
        open ? (
          <section class="bookmarklet-panel" aria-label="Bookmarklets">
            <header>
              <div>
                <strong>Bookmarklets</strong>
                <small>Run JavaScript in the active tab</small>
              </div>
              <button
                type="button"
                class="icon-button"
                aria-label="Close bookmarklets"
                on:click={() => (this.open = false)}
              >
                <span class="material-symbols-outlined">close</span>
              </button>
            </header>

            <div class="bookmarklet-list">
              {use(this.items).map((items) =>
                items.length ? (
                  items.map((item) => (
                    <div class="bookmarklet-row">
                      <button
                        type="button"
                        class="run-bookmarklet"
                        on:click={() => run(item)}
                      >
                        <span class="material-symbols-outlined">
                          play_arrow
                        </span>
                        <span>{item.name}</span>
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={`Edit ${item.name}`}
                        on:click={() => {
                          this.name = item.name;
                          this.code = item.code;
                          this.editingId = item.id;
                          this.message = "";
                        }}
                      >
                        <span class="material-symbols-outlined">edit</span>
                      </button>
                      <button
                        type="button"
                        class="icon-button danger"
                        aria-label={`Delete ${item.name}`}
                        on:click={() => {
                          persist(
                            this.items.filter((entry) => entry.id !== item.id),
                          );
                          if (this.editingId === item.id) clearEditor();
                        }}
                      >
                        <span class="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  ))
                ) : (
                  <p class="empty-state">No bookmarklets saved yet.</p>
                ),
              )}
            </div>

            <div class="bookmarklet-editor">
              <input
                type="text"
                value={use(this.name)}
                placeholder="Bookmarklet name"
                aria-label="Bookmarklet name"
                on:input={(event: InputEvent) => {
                  this.name = (event.target as HTMLInputElement).value;
                }}
              />
              <textarea
                value={use(this.code)}
                placeholder="javascript:document.body.style.background = '#111'"
                aria-label="Bookmarklet JavaScript"
                spellcheck="false"
                on:input={(event: InputEvent) => {
                  this.code = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              <div class="editor-actions">
                {use(this.editingId).map((id) =>
                  id ? (
                    <button
                      type="button"
                      class="cancel-button"
                      on:click={clearEditor}
                    >
                      Cancel
                    </button>
                  ) : null,
                )}
                <button type="button" class="save-button" on:click={save}>
                  {use(this.editingId).map((id) =>
                    id ? "Update" : "Add bookmarklet",
                  )}
                </button>
              </div>
              {use(this.message).map((message) =>
                message ? (
                  <p class="bookmarklet-message" role="status">
                    {message}
                  </p>
                ) : null,
              )}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
};

BookmarkletMenu.style = css`
  :scope {
    position: relative;
  }
  .bookmarklet-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 999px;
    color: #91a59e;
    background: rgba(255, 255, 255, 0.035);
    cursor: pointer;
    font: inherit;
    font-size: 0.68rem;
    font-weight: 650;
  }
  .bookmarklet-trigger:hover,
  .bookmarklet-trigger.active {
    border-color: var(--accent-border, rgba(0, 255, 136, 0.4));
    color: var(--accent-text, #70ffb7);
    background: var(--accent-dim, rgba(0, 255, 136, 0.13));
  }
  .bookmarklet-trigger .material-symbols-outlined {
    font-size: 14px !important;
  }
  .bookmarklet-panel {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    z-index: 50;
    width: min(390px, calc(100vw - 24px));
    overflow: hidden;
    border: 1px solid var(--accent-border, rgba(0, 255, 136, 0.3));
    border-radius: 14px;
    background: rgba(6, 16, 15, 0.98);
    box-shadow:
      0 24px 70px rgba(0, 0, 0, 0.55),
      inset 0 1px rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(24px);
  }
  header,
  .bookmarklet-row,
  .editor-actions {
    display: flex;
    align-items: center;
  }
  header {
    justify-content: space-between;
    padding: 14px 14px 12px;
    border-bottom: 1px solid var(--line);
  }
  header div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  header strong {
    font-size: 0.86rem;
  }
  header small {
    color: var(--text-3);
    font-size: 0.66rem;
  }
  .bookmarklet-list {
    max-height: 210px;
    overflow: auto;
    padding: 8px;
  }
  .bookmarklet-row {
    gap: 4px;
    padding: 3px;
    border-radius: 9px;
  }
  .bookmarklet-row:hover {
    background: rgba(255, 255, 255, 0.035);
  }
  .run-bookmarklet {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 8px;
    border: 0;
    color: #eafff5;
    background: transparent;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .run-bookmarklet span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-bookmarklet .material-symbols-outlined {
    color: var(--accent-text);
    font-size: 17px !important;
  }
  .icon-button {
    display: inline-grid;
    width: 29px;
    height: 29px;
    padding: 0;
    place-items: center;
    border: 0;
    border-radius: 8px;
    color: var(--text-3);
    background: transparent;
    cursor: pointer;
  }
  .icon-button:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
  }
  .icon-button.danger:hover {
    color: #ff8d8d;
    background: rgba(255, 80, 80, 0.1);
  }
  .icon-button .material-symbols-outlined {
    font-size: 16px !important;
  }
  .bookmarklet-editor {
    display: grid;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--line);
  }
  input,
  textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 9px;
    outline: none;
    color: #edfff7;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
  }
  input {
    padding: 9px 10px;
  }
  textarea {
    min-height: 86px;
    resize: vertical;
    padding: 10px;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 0.72rem;
  }
  input:focus,
  textarea:focus {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .editor-actions {
    justify-content: flex-end;
    gap: 7px;
  }
  .save-button,
  .cancel-button {
    padding: 7px 11px;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    font-size: 0.7rem;
    font-weight: 700;
  }
  .save-button {
    border: 1px solid var(--accent-border);
    color: #04100b;
    background: var(--accent, #00ff88);
  }
  .cancel-button {
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text-2);
    background: transparent;
  }
  .bookmarklet-message,
  .empty-state {
    margin: 0;
    color: var(--text-3);
    font-size: 0.68rem;
  }
  .empty-state {
    padding: 12px;
    text-align: center;
  }
  @media (max-width: 760px) {
    .bookmarklet-trigger span:last-child {
      display: none;
    }
  }
`;

export default BookmarkletMenu;
