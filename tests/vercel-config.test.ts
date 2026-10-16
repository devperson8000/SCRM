import test from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
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
    "api/_lib/face-assets/model/face_recognition_model.bin",
    "api/_lib/face-assets/wasm/tfjs-backend-wasm.wasm",
  ])
    assert.ok(files[file], `Missing runtime asset: ${file}`);
});

test("explicit function assets never traverse pnpm symlinked package directories", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  const files = await glob(
    config.functions["api/access.ts"].includeFiles,
    process.cwd(),
  );
  for (const file of Object.keys(files)) {
    assert.equal(
      await realpath(file),
      process.cwd() + "/" + file,
      `Symlinked function asset: ${file}`,
    );
  }
});
