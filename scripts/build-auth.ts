import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Explicit node_modules includes preserve pnpm's symlinked parent directories,
// which Vercel rejects in function packages. Stage ordinary files instead.
const require = createRequire(import.meta.url);
const assets = "api/_lib/face-assets";
const modelSource = join(
  dirname(require.resolve("@vladmandic/face-api/package.json")),
  "model",
);
const wasmSource = dirname(
  require.resolve("@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm"),
);
await mkdir(join(assets, "model"), { recursive: true });
await mkdir(join(assets, "wasm"), { recursive: true });
const models = JSON.parse(await readFile("api/_lib/face-models.json", "utf8"));
for (const name of Object.keys(models))
  await copyFile(join(modelSource, name), join(assets, "model", name));
for (const name of [
  "tfjs-backend-wasm.wasm",
  "tfjs-backend-wasm-simd.wasm",
  "tfjs-backend-wasm-threaded-simd.wasm",
])
  await copyFile(join(wasmSource, name), join(assets, "wasm", name));

// Vercel does not rewrite .ts import specifiers. Bundle the shared runtime once
// into a real .js module that both Vercel function entry points can import.
await build({
  entryPoints: ["api/_lib/auth-http.ts"],
  outfile: "api/_lib/auth-runtime.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
});
