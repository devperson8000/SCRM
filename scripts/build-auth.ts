import { build } from "esbuild";
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
