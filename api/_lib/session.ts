// Shared backend primitives for the access gate.
//
// devserver.ts, api/access.ts and api/wisp-config.ts each used to carry their
// own copy of the cookie/token/rate-limit logic. Three copies of a security
// boundary is three chances for them to drift out of sync — a fix applied to
// one (say, trusting x-forwarded-for) silently left the others exploitable.
// This module is the single implementation all three import.
//
// Files under api/_lib are ignored by Vercel's function router (leading
// underscore), so this is shared code rather than a public endpoint.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/**
 * Bumped from v2: tokens are now per-session and expiring. v2 cookies derived
 * from a constant payload were byte-identical for every visitor and never
 * expired, so one leaked value was a permanent skeleton key.
 */
export const ACCESS_COOKIE = "scramjet_access_v3";

/**
 * The passcode, base64 rather than plaintext, so a glance at this file (or a
 * `grep` across the tree) doesn't hand it over.
 *
 * Be clear-eyed about what that is worth: base64 is an encoding, not a cipher.
 * Anyone holding the source can decode it in one command, and the plaintext is
 * still in this repository's git history. It raises the effort of reading the
 * passcode off a screen from zero to nearly zero — which is the right amount
 * for a gate whose job is to keep the casual visitor out of a demo, and no
 * substitute for SESSION_SECRET, which is the actual security boundary and is
 * never committed.
 *
 * To read it:   printf %s 'MTIzNDU2' | base64 -d
 * To change it: printf %s 'new-passcode' | base64
 */
const ENCODED_PASSCODE = "MTIzNDU2";

/**
 * Hardcoded, and deliberately not overridable from the environment. Reading it
 * from ACCESS_PASSWORD/ACCESS_PASSWORD_SHA256 bought nothing and cost real
 * failures: a value left behind in a deploy platform's project settings
 * silently rejected the documented passcode, and nothing on screen (or in the
 * repo) could explain why.
 */
export const ACCESS_PASSWORD_HASH = sha256Hex(
  Buffer.from(ENCODED_PASSCODE, "base64").toString("utf8"),
);

/** Server-side lifetime of an issued session token. */
export const SESSION_TTL_MS = clampNumber(
  process.env.SESSION_TTL_MS,
  12 * 60 * 60_000,
  60_000,
  30 * 24 * 60 * 60_000,
);

export const MAX_PASSWORD_BYTES = 512;
export const ACCESS_BODY_LIMIT_BYTES = 1024;
export const ACCESS_BODY_TIMEOUT_MS = 5_000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Length-independent equality. timingSafeEqual throws on a length mismatch, so
 * the naive `a.length === b.length && timingSafeEqual(...)` guard leaks length
 * through short-circuiting; comparing digests of both sides keeps the compared
 * buffers a fixed 32 bytes regardless of input.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function sign(signingKey: string, payload: string): string {
  return createHmac("sha256", signingKey).update(payload).digest("hex");
}

/** Mints `<expiresAt>.<nonce>.<signature>`. */
export function issueAccessToken(
  signingKey: string,
  now: number = Date.now(),
): string {
  const payload = `${now + SESSION_TTL_MS}.${randomBytes(12).toString("hex")}`;

  return `${payload}.${sign(signingKey, payload)}`;
}

export function verifyAccessToken(
  signingKey: string,
  token: string | null | undefined,
  now: number = Date.now(),
): boolean {
  // Reject absurd inputs before doing HMAC work, so an oversized cookie can't
  // be used to burn CPU.
  if (!token || token.length > 512) return false;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  // Signature first: an expiry check on unauthenticated data tells an
  // attacker which half of a forged token was wrong.
  if (!constantTimeEquals(signature, sign(signingKey, payload))) return false;

  const expiresAt = Number(payload.slice(0, payload.indexOf(".")));

  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function verifyPassword(password: string): boolean {
  // Hashing an unbounded string is unbounded work; the gate only ever accepts
  // short passphrases.
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;

  return constantTimeEquals(sha256Hex(password), ACCESS_PASSWORD_HASH);
}

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length > name.length && trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }

  return null;
}

export function hasValidAccessCookie(
  signingKey: string,
  headers: IncomingHttpHeaders,
): boolean {
  return verifyAccessToken(
    signingKey,
    readCookie(headers.cookie, ACCESS_COOKIE),
  );
}

/**
 * Deliberately has no Max-Age/Expires: the cookie dies with the browser
 * session, and SESSION_TTL_MS caps it server-side even if the browser keeps it.
 */
export function buildSetCookie(token: string, secure: boolean): string {
  return `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearCookie(secure: boolean): string {
  return `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

/**
 * Expands an IPv6 address to its full eight groups, resolving the "::" run of
 * zeroes. Returns null for anything that isn't parseable as IPv6.
 *
 * Slicing the first four groups off the *textual* form (as this used to) is
 * only correct for an address written out in full. Every compressed form
 * misaligns the groups, and that broke the /64 bucketing in both directions:
 * `2001:db8::1` and `2001:db8::2` are the same /64 but produced different
 * buckets — so the rate limit was bypassable by walking the host part, which is
 * exactly the bypass the /64 bucketing exists to prevent — while
 * `2001:db8::1` and `2001:db8:0:0:0:0:0:1` are the *same address* and also
 * produced different buckets.
 */
function expandIpv6(address: string): string[] | null {
  // A zone index ("fe80::1%eth0") is local scope, not part of the address.
  const bare = address.split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string) => (part ? part.split(":") : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];

  // A trailing IPv4 literal ("::ffff:1.2.3.4", "64:ff9b::192.0.2.1") occupies
  // the last two groups.
  const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
  if (last?.includes(".")) {
    const octets = last.split(".");
    if (octets.length !== 4) return null;
    const bytes = octets.map(Number);
    if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
      return null;
    const pair = [
      ((bytes[0] << 8) | bytes[1]).toString(16),
      ((bytes[2] << 8) | bytes[3]).toString(16),
    ];
    if (tail.length) tail.splice(-1, 1, ...pair);
    else head.splice(-1, 1, ...pair);
  }

  const present = head.length + tail.length;
  if (present > 8) return null;
  if (halves.length === 1 && present !== 8) return null;
  if (!head.concat(tail).every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return [...head, ...Array(8 - present).fill("0"), ...tail].map((group) =>
    parseInt(group, 16).toString(16),
  );
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  // IPv4-mapped IPv6 ("::ffff:1.2.3.4") and plain IPv4 must not hash to
  // different rate-limit buckets for the same client.
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return trimmed.slice(7);
  if (!trimmed.includes(":")) return trimmed;

  // Bucket IPv6 by /64: a single client is routinely handed a whole /64, so
  // per-address limiting is trivially bypassed by picking a new suffix.
  const groups = expandIpv6(trimmed);
  // Unparseable input is bucketed verbatim rather than dropped: an address we
  // can't read is still an identity, and mapping every one of them to a single
  // shared bucket would let one malformed value rate-limit everybody.
  if (!groups) return trimmed;

  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * `trustProxy` must be false when the process is directly reachable — otherwise
 * any client can forge x-forwarded-for and hand itself a fresh rate-limit
 * bucket per request.
 */
export function clientAddress(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const first = chain?.split(",")[0]?.trim();
    if (first) return normalizeAddress(first);

    const real = headers["x-real-ip"];
    const realValue = Array.isArray(real) ? real[0] : real;
    if (realValue) return normalizeAddress(realValue);
  }

  return remoteAddress ? normalizeAddress(remoteAddress) : "unknown";
}

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Fixed-window limiter with a bounded key set.
 *
 * The previous per-file `Map<string, ...>` had no eviction: every distinct
 * source address was remembered forever, so a long-lived dev/Railway process
 * facing a spray of spoofed or rotating addresses grew the map until the
 * process died. Entries here expire and the map is hard-capped.
 */
export class FixedWindowRateLimiter {
  limit: number;
  windowMs: number;
  maxEntries: number;
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: {
    limit: number;
    windowMs: number;
    maxEntries?: number;
  }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  get size(): number {
    return this.hits.size;
  }

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      return { allowed: true, remaining: this.limit, retryAfterSeconds: 0 };
    }

    return {
      allowed: entry.count < this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  /** Counts one attempt against the window and returns the decision for the *next* one. */
  record(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.hits.get(key);
    const next =
      entry && entry.resetAt > now
        ? { count: entry.count + 1, resetAt: entry.resetAt }
        : { count: 1, resetAt: now + this.windowMs };
    this.hits.set(key, next);

    if (this.hits.size > this.maxEntries) this.prune(now);

    return this.check(key, now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }

    // Still over budget after dropping expired windows: evict the entries
    // closest to expiring. Dropping a live limit is strictly better than
    // letting the map grow without bound.
    if (this.hits.size > this.maxEntries) {
      const byExpiry = [...this.hits.entries()].sort(
        (a, b) => a[1].resetAt - b[1].resetAt,
      );
      for (const [key] of byExpiry.slice(0, this.hits.size - this.maxEntries)) {
        this.hits.delete(key);
      }
    }
  }
}

export class BodyReadError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BodyReadError";
    this.status = status;
  }
}

/**
 * Reads and parses a JSON body under both a byte cap and a wall-clock cap.
 *
 * The previous version measured the limit against the decoded *string* length
 * and had no timeout at all, so a slowloris trickling one byte at a time held a
 * request (and its socket) open indefinitely.
 */
export async function readJsonBody<T>(
  request: IncomingMessage,
  options: { limitBytes?: number; timeoutMs?: number } = {},
): Promise<T> {
  const limitBytes = options.limitBytes ?? ACCESS_BODY_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? ACCESS_BODY_TIMEOUT_MS;

  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      if (error) {
        // Stop reading, but leave the socket alive: destroying it here meant
        // the caller's 413/408 response was written to a dead socket and the
        // client saw a bare connection reset instead of the status code.
        // Callers must answer with `Connection: close` so Node tears the
        // connection down once the response has flushed.
        request.pause();
        reject(error);
      } else {
        resolve(value!);
      }
    };

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) {
        finish(new BodyReadError("Request body too large", 413));

        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString("utf8"));
    const onError = (error: Error) =>
      finish(new BodyReadError(error.message, 400));
    // "close" before "end" means the client hung up mid-body.
    const onClose = () => finish(new BodyReadError("Request aborted", 400));

    const timer = setTimeout(
      () => finish(new BodyReadError("Request body timed out", 408)),
      timeoutMs,
    );

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("close", onClose);
  });

  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    throw new BodyReadError("Invalid JSON body", 400);
  }
}

export type LogLevel = "info" | "warn" | "error";

/** Single-line JSON logs, so deploy-platform log search stays greppable. */
export function createLogger(service: string) {
  return function log(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      service,
      event,
      ...fields,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};
