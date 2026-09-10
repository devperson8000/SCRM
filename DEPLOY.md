# Deploying the real Scramjet proxy

This project contains the actual Scramjet service-worker proxy. It is not a
single-file iframe browser.

Scramjet needs two deployed parts:

1. **Web app on Vercel** — the interface, service worker, Scramjet runtime and
   small access/token API functions.
2. **Wisp service on an always-on Node host** — the persistent WebSocket tunnel
   used by the browser transport.

Vercel alone cannot reliably host the Wisp connection because its functions
are not a persistent WebSocket server. A static HTML file cannot replace it
either: service workers require an HTTP(S) origin and the proxy transport needs
a reachable Wisp endpoint.

Use this only for destinations and networks you are authorized to access.

## 1. Create secrets

Generate two different random values on your Mac:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Keep the first as `SESSION_SECRET` and the second as `WISP_SHARED_SECRET`.

## 2. Deploy the Wisp service

Create a Node service from this repository on a persistent host. For Railway
with an existing Vercel project, follow `RAILWAY_SETUP.md`. Railway detects the
included Dockerfile and runs only the Wisp service. For Render, follow
`RENDER_SETUP.md`.

Set this environment variable on the Wisp service:

```text
WISP_SHARED_SECRET=<your second random value>
```

After deployment, note its secure WebSocket URL:

```text
wss://YOUR-WISP-HOST/wisp/
```

## 3. Deploy the web app to Vercel

Import the same repository into Vercel. The included `vercel.json` installs and
builds the correct static output and API functions.

Set these Vercel environment variables:

```text
SESSION_SECRET=<your first random value>
WISP_SHARED_SECRET=<the exact same second value used by Wisp>
WISP_SERVER_PUBLIC_URL=wss://YOUR-WISP-HOST/wisp/
```

Deploy, open the Vercel URL, unlock the workspace, and use the Browser tab.
The default access passcode is documented in `README.md`; change it before
sharing the deployment.

## Local run

On macOS, double-click `Start Scramjet.command`. It installs dependencies on
the first launch, starts both the local web app and its Wisp tunnel, and opens
`http://127.0.0.1:4141/` automatically. Keep the Terminal window open while
using it.

macOS may block a downloaded command the first time. If that happens,
Control-click the file, choose **Open**, and confirm **Open**. This does not
require administrator access.

Opening an HTML page cannot start the server itself because browsers are not
allowed to launch local programs. Use the `.command` launcher instead.

The equivalent Terminal command is:

```sh
pnpm install
pnpm dev
```

Open `http://localhost:4141`. The development server provides the local Wisp
route, so no second process is needed for normal local testing.

## Quick checks

- `GET https://YOUR-WISP-HOST/health` should return JSON with `status: "ok"`.
- The app connection indicator should change to online after unlocking.
- If Vercel reports a missing variable, add the named variable and redeploy.
- The Wisp URL must use `wss://` in production and end in `/wisp/`.
