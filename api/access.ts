import type { VercelRequest, VercelResponse } from "@vercel/node";
// The ".js" extension below is deliberate and must not be "corrected" to ".ts".
// Vercel's builder compiles every traced TypeScript file and ships it renamed
// to .js, but it never rewrites import specifiers -- so an import of
// "./_lib/session.ts" names a file that does not exist in the deployed
// function, and the module fails to load before the handler ever runs. That is
// a 500 on every request, whatever the passcode. devserver.ts and
// wisp-server.ts import this same module as "./api/_lib/session.ts", because
// they run under Node's native type stripping, which resolves only the real
// on-disk extension. Both spellings are correct for their own runtime.
import {
  FixedWindowRateLimiter,
  MAX_PASSWORD_BYTES,
  SECURITY_HEADERS,
  buildSetCookie,
  clearCookie,
  clientAddress,
  createLogger,
  hasValidAccessCookie,
  issueAccessToken,
  verifyPassword,
} from "./_lib/session.js";

// The access gate. Shares one implementation with devserver.ts via _lib rather
// than keeping a second, subtly-different copy here.
//
// Fluid compute reuses instances across invocations, so the in-memory limiter
// is best-effort: it resets whenever Vercel spins up a fresh instance or routes
// to a different region. The signed, expiring cookie is what actually enforces
// the boundary — the limiter only raises the cost of guessing.

const SESSION_SECRET = process.env.SESSION_SECRET;

// Deliberately not a module-scope throw. Failing at cold start is loud in the
// Vercel logs and silent everywhere it matters: the function answers 500 with
// an HTML error page, the gate's `await response.json()` yields null, and the
// browser told the user "Access denied. Check the passcode." — the one
// explanation that is certainly wrong. A missing SESSION_SECRET now reaches
// the person who can fix it, in the UI, by name.
//
// It stays required rather than falling back to a generated key: a per-
// instance random key would mint sessions that die on the next scale event,
// and deriving one from Vercel's deployment identifiers would hang a security
// boundary off values that were never meant to be secret.
const CONFIG_ERROR = SESSION_SECRET
  ? null
  : "Server misconfigured: SESSION_SECRET is not set in the Vercel project settings.";

const accessLimiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 5 * 60_000,
  maxEntries: 5_000,
});

const log = createLogger("api/access");

function send(
  res: VercelResponse,
  status: number,
  body: Record<string, unknown>,
) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }
  res.setHeader("Cache-Control", "no-store");
  // The body depends on the cookie; without this a shared cache could hand
  // one visitor's unlocked state to another.
  res.setHeader("Vary", "Cookie");
  res.status(status).json(body);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CONFIG_ERROR) {
    log("error", "config_invalid", { detail: CONFIG_ERROR });
    send(res, 503, { error: CONFIG_ERROR });

    return;
  }

  if (req.method === "GET") {
    send(res, 200, {
      unlocked: hasValidAccessCookie(SESSION_SECRET!, req.headers),
    });

    return;
  }

  // Explicit lock, so a shared machine can be handed back without waiting out
  // the session TTL.
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", clearCookie(true));
    send(res, 200, { unlocked: false });

    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    send(res, 405, { error: "Method not allowed." });

    return;
  }

  // Everything reaching a Vercel Function has passed through their edge, so
  // x-forwarded-for here is set by infrastructure we control.
  const address = clientAddress(req.headers, req.socket?.remoteAddress, true);
  const limit = accessLimiter.check(address);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    send(res, 429, { error: "Too many attempts. Try again shortly." });

    return;
  }

  // Vercel pre-parses the body, but only when the content-type says JSON;
  // anything else arrives as a string or Buffer and must not throw here.
  let password = "";
  try {
    const raw: unknown = req.body;
    const parsed: unknown =
      typeof raw === "string"
        ? JSON.parse(raw || "{}")
        : Buffer.isBuffer(raw)
          ? JSON.parse(raw.toString("utf8") || "{}")
          : (raw ?? {});
    const candidate = (parsed as { password?: unknown })?.password;
    password = typeof candidate === "string" ? candidate : "";
  } catch {
    send(res, 400, { error: "Invalid access request." });

    return;
  }

  // A malformed oversized request is not a password guess, so it's rejected
  // before it can consume one of the five attempts.
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    send(res, 413, { error: "Invalid access request." });

    return;
  }

  if (!verifyPassword(password)) {
    const { remaining } = accessLimiter.record(address);
    log("warn", "access_denied", { address, remaining });
    send(res, 401, { error: "Access denied." });

    return;
  }

  accessLimiter.reset(address);
  log("info", "access_granted", { address });
  // Vercel serves every deployment over HTTPS, so Secure is unconditional.
  res.setHeader(
    "Set-Cookie",
    buildSetCookie(issueAccessToken(SESSION_SECRET!), true),
  );
  send(res, 200, { unlocked: true });
}
