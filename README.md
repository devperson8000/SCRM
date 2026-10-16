<h1 align="center">Scramjet</h1>
<div align="center">
  <img src="assets/scramjet.png" height="200" />
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/@mercuryworkshop/scramjet"><img src="https://img.shields.io/npm/v/@mercuryworkshop/scramjet.svg?maxAge=3600" alt="npm version" /></a>
  <img src="https://img.shields.io/github/issues/MercuryWorkshop/scramjet?style=flat&color=orange" />
  <img src="https://img.shields.io/github/stars/MercuryWorkshop/scramjet?style=flat&color=orange" />
</div>

---

Scramjet is an experimental interception-based web proxy designed to evade internet censorship and bypass arbitrary browser restrictions.<br><br>
Scramjet allows you to sandbox arbitrary web content, bypass CORS restrictions on loading websites, and instrument and debug websites inside the browser itself. This is accomplished through a combination of interception, rewriting, and sandboxing techniques. You can learn more about the technical details <a href="https://developer.puter.com/blog/how-I-ported-the-web-to-the-web/"><strong>here</strong></a>.<br><br>

## Supported Sites

Some of the popular websites that Scramjet supports include:

- [Google](https://google.com) (partial)
- [Youtube](https://youtube.com)
- [Spotify](https://spotify.com) (partial)
- [Discord](https://discord.com)
- [Reddit](https://reddit.com)
- [GeForce NOW](https://play.geforcenow.com/)
- [now.gg](https://now.gg)

## Development

### Dependencies

- Recent versions of `node.js` and `pnpm`
- `rustup`
- `wasm-bindgen`
- [Binaryen's `wasm-opt`](https://github.com/WebAssembly/binaryen)
- [this `wasm-snip` fork](https://github.com/r58Playz/wasm-snip)

#### Building

- Clone the repository with `git clone --recursive https://github.com/MercuryWorkshop/scramjet`
- Install the dependencies with `pnpm i`
- Build the rewriter with `pnpm rewriter:build`
- Build Scramjet with `pnpm build`

### Running Scramjet Locally

You can run the Scramjet dev server with the command

```sh
pnpm dev
```

The demo page for scramjet should now be running at <http://localhost:4141> and should rebuild upon a file being changed (excluding the rewriter).

### Face-login test branch

This branch uses password plus server-verified face matching, administrator
approval, and PostgreSQL instead of the previous source-controlled passcode.
Follow [FACE_AUTH_SETUP.md](FACE_AUTH_SETUP.md) for the local launcher, one-time
admin setup, test workflow, and preview deployment settings. Do not deploy this
branch over production without completing those steps and real-camera checks.

### Deploying to Vercel

Follow the preview instructions in [FACE_AUTH_SETUP.md](FACE_AUTH_SETUP.md).
The build must run `pnpm auth:build` before Vite to bundle the server runtime.
The new `api/admin.ts` route requires a current admin session. Keep the preview
and its Wisp backend on a separate test database and branch.

#### Importing shared code from a function

Functions in `api/` must import `api/_lib/session.ts` as **`./_lib/session.js`**.
Vercel's builder compiles each traced TypeScript file and ships it renamed to
`.js`, but it never rewrites import specifiers — so a `./_lib/session.ts`
import points at a filename that does not exist in the deployed function, and
the module throws `ERR_MODULE_NOT_FOUND` before the handler runs. Every request
then returns a 500 that looks nothing like a module resolution problem.

`devserver.ts` and `wisp-server.ts` import the same file as `./api/_lib/session.ts`,
because they run under Node's native type stripping, which resolves only the
real on-disk extension. Both spellings are correct; neither is portable to the
other runtime.
