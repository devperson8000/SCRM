import { viteStaticCopy } from "vite-plugin-static-copy";
import { jsxPlugin } from "dreamland/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Anchor root/paths to this file's own location instead of trusting
// process.cwd() — some CI environments (Vercel's build runner, notably)
// invoke `vite build` from a different working directory than a plain
// local `pnpm exec vite build`, which otherwise makes Vite fail to find
// index.html as the build entry.
const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: __dirname,
  resolve: {
    alias: [
      {
        // index.html already loads /scramjet/scramjet.js as a classic script,
        // which is what actually runs the proxy — it assigns the whole library
        // to `self.$scramjet`, and the controller reads it from there. The
        // package's own import entry is the full ~230kB ESM copy of that same
        // library, so every `import { defaultConfig } from
        // "@mercuryworkshop/scramjet"` in app code pulled a second copy into
        // the entry chunk: bytes the browser downloads and parses before the
        // UI can paint, and before the service worker is even registered.
        //
        // dist/scramjet-external.mjs is the build's auto-generated stub that
        // re-exports globalThis.$scramjet, so this points app code at the copy
        // that's already there. It also keeps class identity intact — a
        // `BareResponse` from a second bundled copy is not `instanceof` the
        // one the running proxy checks against.
        //
        // Exact-match only: @rollup/plugin-alias requires `find` to equal the
        // id or be followed by "/", so scramjet-utils and scramjet-controller
        // are untouched. Types still come from the package's exports map;
        // this alias only affects bundling.
        find: /^@mercuryworkshop\/scramjet$/,
        replacement: join(
          __dirname,
          "node_modules/@mercuryworkshop/scramjet/dist/scramjet-external.mjs",
        ),
      },
    ],
  },
  plugins: [
    jsxPlugin(),
    viteStaticCopy({
      structured: false,
      targets: [
        {
          src: join(__dirname, "node_modules/@mercuryworkshop/scramjet/dist/*"),
          dest: "scramjet",
        },
        {
          src: join(
            __dirname,
            "node_modules/@mercuryworkshop/scramjet-controller/dist/*",
          ),
          dest: "controller",
        },
      ],
    }),
  ],
};
