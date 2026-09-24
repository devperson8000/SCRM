import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  FixedWindowRateLimiter,
  SECURITY_HEADERS,
  clientAddress,
  hasValidAccessCookie,
} from "./_lib/session.js";

const SESSION_SECRET = process.env.SESSION_SECRET;
const WISP_SHARED_SECRET = process.env.WISP_SHARED_SECRET;
const WISP_SERVER_PUBLIC_URL = process.env.WISP_SERVER_PUBLIC_URL;
const WISP_SERVER_PUBLIC_URL_SECONDARY =
  process.env.WISP_SERVER_PUBLIC_URL_SECONDARY;

const WISP_URLS = [
  WISP_SERVER_PUBLIC_URL,
  WISP_SERVER_PUBLIC_URL_SECONDARY,
];

const limiter = new FixedWindowRateLimiter({
  limit: 90,
  windowMs: 60_000,
  maxEntries: 5_000,
});

function parseSlot(value: unknown): 0 | 1 | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "0" || raw === "1") return Number(raw) as 0 | 1;
  return null;
}

function publicHttpOrigin(wispUrl: string): string {
  const parsed = new URL(wispUrl);
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else throw new Error("Configured WISP URL must use ws:// or wss://");
  return parsed.origin;
}

function mintControlToken(): string {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", WISP_SHARED_SECRET!)
    .update(`miner:${timestamp}`)
    .digest("hex");
  return `${timestamp}.${signature}`;
}

async function forward(
  wispUrl: string,
  action: "status" | "source" | "start" | "stop",
  method: "GET" | "POST",
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(`${publicHttpOrigin(wispUrl)}/miner/${action}`, {
      method,
      headers: {
        Accept: "application/json",
        "x-scrm-control-token": mintControlToken(),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie");

  if (!SESSION_SECRET || !WISP_SHARED_SECRET) {
    res.status(503).json({
      error:
        "Miner control is not configured: SESSION_SECRET and WISP_SHARED_SECRET are required.",
    });
    return;
  }

  if (!hasValidAccessCookie(SESSION_SECRET, req.headers)) {
    res.status(401).json({ error: "Unlock the workspace first." });
    return;
  }

  const address = clientAddress(req.headers, req.socket?.remoteAddress, true);
  const decision = limiter.check(address);
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({ error: "Too many miner-control requests." });
    return;
  }
  limiter.record(address);

  const slot = parseSlot(req.query.slot);
  if (slot === null) {
    res.status(400).json({ error: "slot must be 0 or 1." });
    return;
  }

  const wispUrl = WISP_URLS[slot];
  if (!wispUrl) {
    res.status(503).json({
      error:
        slot === 0
          ? "Primary WISP server is not configured."
          : "Secondary WISP server is not configured.",
    });
    return;
  }

  const rawAction = Array.isArray(req.query.action)
    ? req.query.action[0]
    : req.query.action;
  const action =
    rawAction === "source" ||
    rawAction === "start" ||
    rawAction === "stop" ||
    rawAction === "status"
      ? rawAction
      : "status";

  const expectedMethod =
    action === "start" || action === "stop" ? "POST" : "GET";
  if (req.method !== expectedMethod) {
    res.setHeader("Allow", expectedMethod);
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const upstream = await forward(wispUrl, action, expectedMethod);
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType =
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
    res.setHeader("Content-Type", contentType);
    res.send(text);
  } catch (error) {
    res.status(502).json({
      error:
        error instanceof Error
          ? `Could not reach cloud miner ${slot + 1}: ${error.message}`
          : `Could not reach cloud miner ${slot + 1}.`,
    });
  }
}
