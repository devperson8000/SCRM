# Deploy this package to Vercel

The required Vercel environment-variable names are:

```text
SESSION_SECRET
WISP_SHARED_SECRET
WISP_SERVER_PUBLIC_URL
WISP_SERVER_PUBLIC_URL_SECONDARY
```

- `SESSION_SECRET` must be a long random value used only by Vercel.
- `WISP_SHARED_SECRET` must exactly match the value configured on every Wisp
  service.
- `WISP_SERVER_PUBLIC_URL` must be the primary Wisp service's public domain
  written as a secure WebSocket URL ending in `/wisp/`, for example:

```text
wss://wisp--scrm-wisp--lv6jhkdf7l44.code.run/wisp/
```

- `WISP_SERVER_PUBLIC_URL_SECONDARY` is optional. When set, it must be the
  second Wisp service's public domain written as a
  secure WebSocket URL ending in `/wisp/`, for example:

```text
wss://wisp2--scrm-wisp-2--lv6jhkdf7l44.code.run/wisp/
```

With both URLs configured, each fresh app startup alternates between them.
Retries within one startup remain on the selected service. If the secondary
variable is omitted, every startup continues using the primary service.

For a Git-connected Vercel project, copy this package's contents into the
repository root, commit, and push. Vercel reads `vercel.json`, installs with
pnpm, builds the static app, and deploys the functions in `api/`.

Apply all required variables to the environments you use, such as Production and
Preview, then redeploy the latest commit. Verify the deployment by opening:

```text
https://YOUR-VERCEL-DOMAIN/api/access
```

A working deployment returns JSON. If `/api/wisp-config` returns a 503 after
unlocking, its response identifies the missing or invalid variable.
