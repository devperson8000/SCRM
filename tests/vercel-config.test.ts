import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const vercelRequire = createRequire(
  require.resolve("@vercel/node/package.json"),
);
const { glob } = vercelRequire("@vercel/build-utils");
test("Vercel includeFiles uses a string glob covering the face models and WASM runtime", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  for (const entry of Object.values(config.functions) as any[]) {
    if (entry.includeFiles !== undefined)
      assert.equal(typeof entry.includeFiles, "string");
  }
  const pattern = config.functions["api/access.ts"].includeFiles;
  const files = await glob(pattern, process.cwd());
  for (const file of [
    "api/_lib/face-models.json",
    "node_modules/@vladmandic/face-api/model/face_recognition_model.bin",
    "node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm",
  ])
    assert.ok(files[file], `Missing runtime asset: ${file}`);
});
