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

### Access passcode

Both the dev server and the deployed app sit behind a passcode gate. The same
passcode applies everywhere — local, preview and production — because it is
hardcoded in `api/_lib/session.ts`, base64-encoded rather than spelled out:

```ts
const ENCODED_PASSCODE = "MTIzNDU2";
export const ACCESS_PASSWORD_HASH = sha256Hex(
  Buffer.from(ENCODED_PASSCODE, "base64").toString("utf8"),
);
```

Read it with `printf %s 'MTIzNDU2' | base64 -d`; change it by replacing that
literal with `printf %s 'new-passcode' | base64`. The encoding is obfuscation,
not secrecy — it keeps the passcode from being readable at a glance or by
grepping the tree, and nothing more. The plaintext also remains in this
repository's git history.

No environment variable can change it. `ACCESS_PASSWORD` and
`ACCESS_PASSWORD_SHA256` are no longer read at all, so a stale value sitting in
a deploy platform's project settings can't lock you out of your own deployment
— which is exactly what used to happen, invisibly.

The gate's actual security boundary is `SESSION_SECRET`, which is a real secret
and is not committed.

### Deploying to Vercel

Vercel runs the static build plus the two functions in `api/`. The passcode
needs no configuration; these are secrets and must be set in the project
settings (Settings → Environment Variables) before the first deploy, because
the functions that need them answer `503` with the missing variable named
until they exist:

| Variable                 | Required by       | Notes                                                                                                             |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`         | both functions    | Any long random string. Signs the access cookie; unset means nobody can unlock the app, whatever the passcode is. |
| `WISP_SHARED_SECRET`     | `api/wisp-config` | Must match the standalone wisp server (`wisp-server.ts`).                                                         |
| `WISP_SERVER_PUBLIC_URL` | `api/wisp-config` | e.g. `wss://your-app.up.railway.app/wisp/`. Must be `wss://` (`ws://` is allowed only for localhost).             |

`SESSION_SECRET` is deliberately not defaulted, and deliberately not committed:
a generated per-instance key would sign sessions that stop verifying the moment
Vercel starts another instance, which reads as a random, unreproducible logout.

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
