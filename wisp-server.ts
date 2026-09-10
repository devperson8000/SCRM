// Standalone always-on wisp tunnel server, meant to run on Railway (or any
// persistent Node host) — NOT on Vercel. Wisp is a stateful, multiplexed
// protocol: it needs one consistent long-lived process holding the
// connection open for an entire browsing session, which serverless/edge
// functions (Vercel, Supabase, Cloudflare Workers, ...) cannot reliably
// provide since they can recycle or move instances mid-session regardless
// of any advertised duration cap.
//
// This process does exactly one thing: authenticate and upgrade /wisp/
// connections. It does not serve the app itself (that stays on Vercel).
//
// Reliability notes (audited against @mercuryworkshop/wisp-js@0.4.1):
//  - The upstream TCP dial performed per-stream inside wisp-js had no
//    connect timeout: a blackholed/firewalled destination left a stream
//    "connecting" forever, bounded only by the OS's own TCP timeout (often
//    minutes) — a real socket/stream leak vector under adversarial or just
//    unreliable destinations. Fixed via a local patch (patches/@mercury
//    workshop__wisp-js@0.4.1.patch) adding `options.connect_timeout_ms`.
//  - wisp-js's own websocket handling has no `on("error", ...)` listener
//    anywhere in its client-connection object; combined with no process-
//    level uncaughtException/unhandledRejection handlers here, a single
//    malformed frame or a mistimed ECONNRESET could have thrown an
//    unhandled error and crashed the entire process — killing every
//    active tunnel for every user at once. That's the single biggest
//    point of failure in this service; the safety nets below exist
//    specifically to close it.
//  - No stream/connection caps meant one runaway client (buggy or
//    malicious) could exhaust file descriptors for everyone. Bounded via
//    stream_limit_per_host / stream_limit_total below, acting as a basic
//    circuit breaker against resource exhaustion.
//  - No HTTP keep-alive/header/request timeouts were set, no SIGTERM
//    handling (Railway sends SIGTERM on every redeploy), and health was
//    only a bare 200 OK with no diagnostics.

import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";
import { createHmac } from "node:crypto";
import type { Socket } from "node:net";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import {
  FixedWindowRateLimiter,
  clientAddress,
  constantTimeEquals,
  createLogger,
} from "./api/_lib/session.ts";

const PORT = Number(process.env.PORT) || 4142;
const WISP_SHARED_SECRET = process.env.WISP_SHARED_SECRET;

// Connection-pooling / timeout tuning. Defaults are conservative but
// overridable per-deployment without a code change.
const CONNECT_TIMEOUT_MS =
  Number(process.env.WISP_CONNECT_TIMEOUT_MS) || 10_000;
const STREAM_LIMIT_PER_HOST =
  Number(process.env.WISP_STREAM_LIMIT_PER_HOST) || 64;
const STREAM_LIMIT_TOTAL = Number(process.env.WISP_STREAM_LIMIT_TOTAL) || 2_000;
const DNS_TTL_MS = Number(process.env.WISP_DNS_TTL_MS) || 60_000;
// Node's keep-alive timeout must exceed any intermediary's (Railway's edge,
// browsers) idle timeout, or we'll be the side that closes first and the
// client sees a mid-request connection reset instead of a clean reuse.
const KEEP_ALIVE_TIMEOUT_MS =
  Number(process.env.WISP_KEEP_ALIVE_TIMEOUT_MS) || 75_000;
const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 5_000;
const SHUTDOWN_GRACE_MS = Number(process.env.WISP_SHUTDOWN_GRACE_MS) || 10_000;
// Upgrades per client per minute. A valid token is reusable for its 60s
// lifetime, so without this one leaked token is an unbounded connection
// faucet; the cap turns that into a bounded, self-healing burst.
const UPGRADE_LIMIT_PER_MIN =
  Number(process.env.WISP_UPGRADE_LIMIT_PER_MIN) || 120;
// Railway (and every other managed host) terminates TLS in front of us, so the
// socket address is always the edge's. Opt out when exposing the port directly,
// or x-forwarded-for becomes an attacker-controlled rate-limit bypass.
const TRUST_PROXY = process.env.WISP_TRUST_PROXY !== "0";
// Wisp is per-connection stateful but shares nothing between connections, so
// workers scale cleanly across cores. Left at 1 unless asked for.
const WORKERS = Math.max(
  1,
  Math.min(
    Number(process.env.WISP_WORKERS) || 1,
    os.availableParallelism?.() ?? os.cpus().length,
  ),
);
// The primary supervises workers and never binds the port itself, so the
// single-process serving paths below must not run in it.
const IS_CLUSTER_PRIMARY = WORKERS > 1 && cluster.isPrimary;

if (!WISP_SHARED_SECRET) {
  throw new Error(
    "WISP_SHARED_SECRET env var is required — it must match the value " +
      "configured on the Vercel deployment's api/wisp-config.ts",
  );
}

logging.set_level(
  process.env.WISP_LOG_LEVEL === "debug" ? logging.DEBUG : logging.INFO,
);

// Keep proxy requests off private and loopback networks by default. Enabling
// these options would turn this into an SSRF surface.
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.connect_timeout_ms = CONNECT_TIMEOUT_MS;
// Circuit breaker: cap concurrent streams so one runaway client/target
// can't exhaust file descriptors for every other tunnel on the box.
wisp.options.stream_limit_per_host = STREAM_LIMIT_PER_HOST;
wisp.options.stream_limit_total = STREAM_LIMIT_TOTAL;
wisp.options.dns_ttl = DNS_TTL_MS;

// ---- structured logging -----------------------------------------------
// wisp-js logs its own protocol/DNS/handshake internals; this covers the
// auth and connection-lifecycle events this file is directly responsible
// for, in a consistently greppable shape.
const log = createLogger("wisp-server");

// ---- token auth ----------------------------------------------------------
function isValidToken(token: string | null): boolean {
  // Bound the work an unauthenticated client can make us do: HMAC over an
  // arbitrarily long path segment is free CPU burn for the attacker.
  if (!token || token.length > 256) return false;
  const [timestampStr, signature] = token.split(".");
  if (!timestampStr || !signature) return false;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return false;
  // Tokens are minted on-demand right before connecting and are only
  // meant to authorize that one connection attempt.
  if (Math.abs(Date.now() - timestamp) > 60_000) return false;

  const expected = createHmac("sha256", WISP_SHARED_SECRET!)
    .update(timestampStr)
    .digest("hex");
  return constantTimeEquals(signature, expected);
}

// ---- connection tracking (health checks + graceful shutdown) -------------
const openSockets = new Set<Socket>();
let totalConnectionsServed = 0;
let totalUpgradesRejected = 0;
let draining = false;
const startedAt = Date.now();

const upgradeLimiter = new FixedWindowRateLimiter({
  limit: UPGRADE_LIMIT_PER_MIN,
  windowMs: 60_000,
  maxEntries: 20_000,
});
// The limiter only evicts on insert, so an idle-but-previously-busy process
// would hold every expired window until the next failure. unref'd so it can
// never be the reason the process refuses to exit.
setInterval(() => upgradeLimiter.prune(), 60_000).unref();

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname === "/health" || pathname === "/healthz") {
    // 503 while draining so the platform's load balancer stops sending new
    // sessions to an instance that is about to disappear.
    jsonResponse(res, draining ? 503 : 200, {
      status: draining ? "draining" : "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      openConnections: openSockets.size,
      totalConnectionsServed,
      totalUpgradesRejected,
      rateLimitBuckets: upgradeLimiter.size,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      workers: WORKERS,
      pid: process.pid,
    });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
  });
  res.end("wisp tunnel server\n");
});

// Node's defaults (keepAliveTimeout: 5s) are far too aggressive for a
// tunnel meant to hold connections open for an entire browsing session —
// this is the "prevent dropped persistent connections" half of keep-alive
// tuning; headersTimeout must stay above it or Node's own guard rejects
// slow-but-legitimate clients.
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
// Only bounds plain HTTP requests (health checks); upgraded tunnels are
// detached from the HTTP layer and keep running past it.
server.requestTimeout = 30_000;
// Caps the per-connection header table a client can make us allocate.
server.maxHeadersCount = 100;

// A raw socket-level error (ECONNRESET, etc.) with no listener attached
// throws and crashes the whole process in Node. Track every socket the
// server accepts so we can (a) always have an error listener on it and
// (b) know the live connection count for /health and graceful shutdown.
server.on("connection", (socket) => {
  openSockets.add(socket);
  socket.on("error", (error) => {
    log("warn", "socket_error", {
      remote: socket.remoteAddress,
      error: String(error),
    });
  });
  socket.on("close", () => {
    openSockets.delete(socket);
  });
});

// Malformed HTTP from a client (not an upgrade) previously had no handler
// at all -- Node's default is to destroy the socket, but doing it
// ourselves means it's logged instead of silently vanishing.
server.on("clientError", (error, socket) => {
  log("warn", "client_error", { error: String(error) });
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.on("upgrade", (req, rawSocket, head) => {
  // http.Server's "upgrade" event types the socket as a bare stream.Duplex,
  // but for an HTTP server it is always a real net.Socket at runtime.
  const socket = rawSocket as Socket;
  // Every socket handed to us here needs its own error listener *before*
  // we do anything else with it -- an ECONNRESET while we're still
  // validating the token, with no listener yet attached, is exactly the
  // kind of unhandled 'error' that takes the whole process down.
  socket.on("error", (error) => {
    log("warn", "upgrade_socket_error", {
      remote: socket.remoteAddress,
      error: String(error),
    });
  });
  // Tunnelled traffic is mostly small, latency-sensitive frames; Nagle
  // batching adds up to ~40ms per write here in exchange for nothing.
  socket.setNoDelay(true);
  // A wisp tunnel can sit idle for minutes at a time, which is exactly the
  // window in which a NAT entry expires, a laptop suspends or a network path
  // disappears. Without TCP keep-alive probes none of that is observable from
  // this side: the socket stays "open" indefinitely, counted in /health and
  // holding a file descriptor, and the browser's reconnect never gets a close
  // event to react to. 60s to first probe is well inside the typical 5-minute
  // NAT idle timeout.
  socket.setKeepAlive(true, 60_000);

  const address = clientAddress(req.headers, socket.remoteAddress, TRUST_PROXY);
  const reject = (status: string, reason: string) => {
    totalUpgradesRejected++;
    log("warn", "upgrade_rejected", { reason, url: req.url, address });
    if (socket.writable) {
      // end(), not write()-then-destroy(): destroy() tears the socket down
      // without waiting for the write to flush, so the client could see a
      // bare connection reset in place of the status line telling it why it
      // was turned away. end() writes, sends FIN, and closes on its own.
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    } else {
      socket.destroy();
    }
  };

  // Refusing new tunnels during the drain window keeps a redeploy from
  // handing a client a connection that is about to be torn down anyway.
  if (draining) return reject("503 Service Unavailable", "draining");

  if (!req.url?.startsWith("/wisp/")) {
    return reject("404 Not Found", "bad_path");
  }

  if (!upgradeLimiter.check(address).allowed) {
    return reject("429 Too Many Requests", "rate_limited");
  }
  // Counted here, before the token is even examined, so that *every* upgrade
  // attempt counts against the window. Recording only the rejected ones (as
  // this used to) left the accepted ones unmetered, which defeated the entire
  // reason this limiter exists: a valid token is replayable for its whole 60s
  // lifetime, so one leaked token was still an unbounded connection faucet and
  // the cap it was supposed to impose never applied.
  upgradeLimiter.record(address);

  // The wisp client library requires the WebSocket URL string it's given to
  // end with a trailing slash, which rules out a "?token=" query string —
  // so the token travels as a path segment instead:
  // wss://host/wisp/<token>/
  const rest = req.url.slice("/wisp/".length);
  const token = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  if (!isValidToken(token)) {
    return reject("401 Unauthorized", "bad_token");
  }

  // Normalize the URL back to the bare wisp path before handing off — the
  // token segment is our auth concern, not the wisp library's.
  req.url = "/wisp/";
  totalConnectionsServed++;
  log("info", "upgrade_accepted", {
    address,
    openConnections: openSockets.size,
    totalConnectionsServed,
  });

  try {
    wisp.routeRequest(req, socket, head);
  } catch (error) {
    // wisp-js already isolates most async failures per-connection, but a
    // synchronous throw here (e.g. a future library change) shouldn't be
    // allowed to reach the process-level handlers below and, depending on
    // where it originated, potentially take other in-flight connections
    // down with it.
    log("error", "route_request_failed", {
      address,
      error: String(error),
    });
    socket.destroy();
  }
});

// ---- process-level safety net ---------------------------------------------
// This is the fix for the single biggest point of failure in this service:
// without these, any unhandled error on any connection (a malformed wisp
// frame, a websocket protocol violation, a promise rejection anywhere in
// wisp-js's per-stream plumbing) crashes the entire Node process and drops
// every other user's tunnel with it. One bad connection must never be able
// to take down every other connection.
process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", {
    error: String(error),
    stack: error.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { reason: String(reason) });
});

function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  log("info", "shutdown_start", { signal, openConnections: openSockets.size });
  // Stop accepting new connections immediately; let in-flight ones finish
  // naturally for a grace period instead of hard-killing every tunnel the
  // instant a redeploy starts.
  server.close(() => {
    log("info", "shutdown_complete", { signal });
    process.exit(0);
  });
  // server.close() alone never resolves while keep-alive sockets sit idle,
  // so idle connections are closed out from under it right away and only
  // actively-used tunnels get the full grace period.
  server.closeIdleConnections();
  setTimeout(() => {
    log("warn", "shutdown_forced", {
      signal,
      remainingConnections: openSockets.size,
    });
    for (const socket of openSockets) socket.destroy();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
}
// Registered only in the process that owns the listening socket: in the
// cluster primary this same handler would call server.close() on a server that
// never listened, whose callback fires immediately and would exit the primary
// out from under the still-draining workers.
if (!IS_CLUSTER_PRIMARY) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
// Distinct from the per-connection safety nets above: a failure to bind the
// listening port at all (EADDRINUSE, EACCES, ...) means there is nothing to
// serve, so unlike a single bad connection this should exit loudly and let
// the host's restart policy (Railway's restartPolicyType in railway.json)
// bring up a fresh attempt, rather than staying alive dark and unreachable.
server.on("error", (error) => {
  log("error", "server_error", { error: String(error) });
  process.exit(1);
});

function listen() {
  server.listen(PORT, "0.0.0.0", () => {
    log("info", "server_listening", {
      port: PORT,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      streamLimitPerHost: STREAM_LIMIT_PER_HOST,
      streamLimitTotal: STREAM_LIMIT_TOTAL,
      keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
      upgradeLimitPerMin: UPGRADE_LIMIT_PER_MIN,
      trustProxy: TRUST_PROXY,
      pid: process.pid,
    });
  });
}

// Each tunnel lives entirely inside one worker and shares no state with the
// others, so round-robin accept across workers is safe and turns a
// single-core bottleneck into N. A worker that dies is replaced rather than
// silently reducing capacity for the rest of the deployment's life.
if (IS_CLUSTER_PRIMARY) {
  let primaryDraining = false;
  log("info", "cluster_start", { workers: WORKERS, port: PORT });
  for (let i = 0; i < WORKERS; i++) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    log("warn", "worker_exited", { pid: worker.process.pid, code, signal });
    if (!primaryDraining) {
      cluster.fork();

      return;
    }
    // The primary is this container's PID 1: exiting while workers are still
    // draining takes them down with it, so it outlives them by design.
    if (Object.keys(cluster.workers ?? {}).length === 0) {
      log("info", "cluster_shutdown_complete", {});
      process.exit(0);
    }
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (primaryDraining) return;
      primaryDraining = true;
      log("info", "cluster_shutdown", { signal });
      // Forward the signal so each worker runs its own graceful drain
      // instead of being killed mid-tunnel.
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.process.kill(signal);
      }
      setTimeout(() => {
        log("warn", "cluster_shutdown_forced", { signal });
        process.exit(0);
      }, SHUTDOWN_GRACE_MS + 2_000).unref();
    });
  }
} else {
  listen();
}
