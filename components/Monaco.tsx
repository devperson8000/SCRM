import { css, type Component } from "dreamland/core";

// monaco-editor is imported dynamically, on mount, rather than at module scope.
// Statically it dominated the main bundle -- the editor is only ever shown on
// the Playground and Request Viewer tabs, but every visitor downloaded and
// parsed all of it before the proxy's own UI could paint, which is the worst
// possible trade for a page whose entire job is to open somebody else's site.
// Deferring it costs a brief blank editor box on those two secondary tabs.
type MonacoApi = typeof import("monaco-editor/editor/editor.api");

// One shared promise: two editors mounting at once (Playground has two) must
// not each pull the chunk, and remounting a tab must not re-import it.
let monacoModule: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  monacoModule ??= (async () => {
    // Must be set before editor.main.js evaluates: it reads MonacoEnvironment
    // while initializing, and a missing getWorkerUrl makes it try to spawn
    // workers from URLs this build doesn't emit.
    if (!(globalThis as any).MonacoEnvironment) {
      (globalThis as any).MonacoEnvironment = {
        getWorkerUrl() {
          return "data:application/javascript,";
        },
      };
    }
    const api = await import("monaco-editor/editor/editor.api");
    await import("monaco-editor/editor/editor.main.js");

    return api;
  })();

  return monacoModule;
}

type MonacoProps = {
  value: string;
  language?: string;
  readOnly?: boolean;
  minHeight?: number;
  fill?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
};

const Monaco: Component<MonacoProps, {}, { instance?: any }> = function (cx) {
  cx.mount = async () => {
    const monaco = await loadMonaco();
    // The tab can be closed while the chunk is still in flight; creating an
    // editor on a detached node leaks it and throws on layout.
    if (!cx.root.isConnected) return;
    this.instance = monaco.editor.create(cx.root, {
      value: this.value ?? "",
      language: this.language ?? "plaintext",
      readOnly: this.readOnly ?? true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: "on",
      renderLineHighlight: "none",
      theme: "vs-dark",
    });

    this.instance.onDidChangeModelContent(() => {
      this.onChange?.(this.instance.getValue());
    });

    this.instance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        this.onSave?.();
      },
    );

    use(this.value).listen((next) => {
      if (!this.instance) return;
      const current = this.instance.getValue();
      if (current !== next) {
        this.instance.setValue(next ?? "");
      }
    });

    use(this.language).listen((next) => {
      if (!this.instance || !this.instance.getModel()) return;
      monaco.editor.setModelLanguage(
        this.instance.getModel(),
        next ?? "plaintext",
      );
    });

    use(this.readOnly).listen((next) => {
      if (!this.instance) return;
      this.instance.updateOptions({ readOnly: next ?? true });
    });
  };

  // No disposal hook here on purpose: dreamland's ComponentContext exposes
  // only `init` and `mount` (see dreamland/core.d.ts) -- there is no unmount
  // callback to hang editor.dispose() off, and `cx.cleanup = ...`, which
  // several components in this tree assign, is silently never called. These
  // editors are mounted once for the life of the page, so nothing leaks in
  // practice; a future tab that mounts and unmounts them would need the
  // framework gap closed first.

  return (
    <div
      class={`monaco-host ${this.fill ? "fill" : ""}`}
      style={
        this.fill
          ? "min-height: 0; height: 100%;"
          : `min-height: ${this.minHeight ?? 260}px; height: ${this.minHeight ?? 260}px;`
      }
    />
  );
};

Monaco.style = css`
  :scope {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    min-height: 200px;
    height: auto;
    flex: 0 0 auto;
    border-radius: 0;
    overflow: hidden;
    border: 0;
    background: #111;
  }
  :scope.fill {
    flex: 1;
    height: 100%;
    min-height: 0;
  }
  .monaco-host {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    min-height: 200px;
    height: 100%;
  }
  .monaco-host.fill {
    min-height: 0;
  }
`;
export default Monaco;
