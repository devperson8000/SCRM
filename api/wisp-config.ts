import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac } from "node:crypto";
// ".js", not ".ts" -- see the note in api/access.ts. Vercel ships compiled
// TypeScript renamed to .js without rewriting specifiers, so importing the
// ".ts" path crashes the function at module load.
import {
  FixedWindowRateLimiter,
  SECURITY_HEADERS,
  clientAddress,
  createLogger,
  hasValidAccessCookie,
} from "./_lib/session.js";

// Mints a short-lived token authorizing the browser to connect directly to
// the standalone wisp server (see wisp-server.ts, deployed separately on an
// always-on host like Railway — wisp needs a persistent process, which no
// serverless platform can reliably provide for a stateful multiplexed
// connection). Gated behind the same access cookie as the rest of the app,
// so only unlocked sessions can obtain a token.

const SESSION_SECRET = process.env.SESSION_SECRET;
const WISP_SHARED_SECRET = process.env.WISP_SHARED_SECRET;
const WISP_SERVER_PUBLIC_URL = process.env.WISP_SERVER_PUBLIC_URL;

// Reported through the handler rather than thrown at cold start, for the same
// reason as api/access.ts: a module-scope throw becomes an opaque 500 whose
// body is HTML, which the browser could only render as a generic startup
// failure. Answering with the actual reason means a misconfigured deployment
// explains itself on screen instead of looking like a dead wisp tunnel.
const CONFIG_ERROR = ((): string | null => {
  if (!SESSION_SECRET) {
    return "Server misconfigured: SESSION_SECRET is not set.";
  }
  if (!WISP_SHARED_SECRET) {
    return (
      "Server misconfigured: WISP_SHARED_SECRET is not set — it must match " +
      "the value configured on the standalone wisp server (wisp-server.ts)."
    );
  }
  if (!WISP_SERVER_PUBLIC_URL) {
    return (
      "Server misconfigured: WISP_SERVER_PUBLIC_URL is not set, e.g. " +
      "wss://your-app.up.railway.app/wisp/"
    );
  }
  // A token minted against an http:// URL would be sent over a plaintext
  // WebSocket, exposing every proxied request.
  if (
    !/^wss:\/\//i.test(WISP_SERVER_PUBLIC_URL) &&
    !/^ws:\/\/localhost/i.test(WISP_SERVER_PUBLIC_URL)
  ) {
    return (
      "Server misconfigured: WISP_SERVER_PUBLIC_URL must use wss:// " +
      "(ws:// is only allowed for localhost)."
    );
  }

  return null;
})();

const log = createLogger("api/wisp-config");

// An unlocked session shouldn't be able to mint tokens in a loop; the wisp
// server rate-limits upgrades too, but stopping it here saves the round trip.
const tokenLimiter = new FixedWindowRateLimiter({
  limit: 60,
  windowMs: 60_000,
  maxEntries: 5_000,
});

function mintWispToken(): string {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", WISP_SHARED_SECRET!)
    .update(timestamp)
    .digest("hex");
  return `${timestamp}.${signature}`;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }
  res.setHeader("Cache-Control", "no-store");
  // The token is per-session; a cache keyed without the cookie would serve
  // one visitor's credential to the next.
  res.setHeader("Vary", "Cookie");

  if (CONFIG_ERROR) {
    log("error", "config_invalid", { detail: CONFIG_ERROR });
    res.status(503).json({ error: CONFIG_ERROR });
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!hasValidAccessCookie(SESSION_SECRET!, req.headers)) {
    res.status(401).json({ error: "Unlock the workspace first." });
    return;
  }

  const address = clientAddress(req.headers, req.socket?.remoteAddress, true);
  const limit = tokenLimiter.check(address);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({ error: "Too many token requests." });
    return;
  }
  tokenLimiter.record(address);

  log("info", "wisp_token_issued", { address });
  res.status(200).json({
    wispUrl: WISP_SERVER_PUBLIC_URL,
    token: mintWispToken(),
  });
}
