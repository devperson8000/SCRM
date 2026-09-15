# Render setup

Render hosts the persistent Wisp WebSocket backend. Keep the web app and its
small API functions on Vercel.

## 1. Create the Wisp service

1. Sign in to Render and choose **New → Blueprint**.
2. Connect GitHub and select `devperson8000/SCRM`.
3. Render will detect the root `render.yaml`. Confirm the `scrm-wisp` service.
4. When prompted for `WISP_SHARED_SECRET`, paste a random secret. You can
   generate one on macOS with:

   ```sh
   openssl rand -hex 32
   ```

5. Apply the Blueprint and wait for the deploy to finish.

The Blueprint uses the repository's `Dockerfile`, deploys the `main` branch in
Singapore, checks `/health`, and automatically redeploys after each commit.
Render supplies `PORT`; do not create or override it.

## 2. Check the backend

Replace `YOUR-SERVICE` with the hostname shown by Render:

```text
https://YOUR-SERVICE.onrender.com/health
```

It should return JSON containing `"status":"ok"`. The matching Wisp URL is:

```text
wss://YOUR-SERVICE.onrender.com/wisp/
```

Use `wss://`, not `ws://`, and keep the trailing `/`.

## 3. Connect the Vercel frontend

In the existing Vercel project, open **Settings → Environment Variables** and
set:

```text
WISP_SHARED_SECRET=<the exact value used on Render>
WISP_SERVER_PUBLIC_URL=wss://YOUR-SERVICE.onrender.com/wisp/
```

Keep the existing `SESSION_SECRET`. Redeploy the Vercel project so its
`api/wisp-config` function receives the new values.

## 4. Final check

1. Open the Vercel app and unlock it.
2. Wait for the connection indicator to show online.
3. Open a site in the Browser tab.

If the connection stays offline, first open the Render `/health` URL and then
check that both deployments use the exact same `WISP_SHARED_SECRET`.

## Free-plan limitation

The included Blueprint selects Render's Free plan. A free web service spins
down after 15 minutes without inbound HTTP traffic or WebSocket messages and
can take about a minute to wake. Existing active Wisp traffic counts as inbound
activity. Switch the service to a paid instance if you need consistently fast,
always-ready connections.
