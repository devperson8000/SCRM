import { createServer } from "vite";
import fs from "node:fs/promises";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import rspackConfig from "./rspack.config.ts";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import {
  BodyReadError,
  FixedWindowRateLimiter,
  SECURITY_HEADERS,
  buildSetCookie,
  clientAddress,
  createLogger,
  hasValidAccessCookie,
  issueAccessToken,
  readJsonBody,
  verifyPassword,
} from "./api/_lib/session.ts";
import {
  black,
  normalizeWebsocketUrl,
  logSuccess,
  printBanner,
  resetSuccessLog,
  runRspack,
  warnOnUrlEscape,
} from "./devlib.ts";

const log = createLogger("devserver");

// Server-only modules that live in the project root alongside client source.
// Vite would otherwise transform and serve these to any browser that asks.
const SERVER_ONLY_MODULES = new Set([
  "/devserver.ts",
  "/devlib.ts",
  "/wisp-server.ts",
]);

// These were unguarded top-level calls: a shallow clone, a missing .git, or a
// moved asset killed the dev server before it ever bound a port, leaving only a
// raw stack trace to explain why `pnpm dev` did nothing.
function gitOutput(args: string[], fallback: string): string {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\r?\n|\r/g, "");

    return out.trim() || fallback;
  } catch {
    return fallback;
  }
}

const image = await fs
  .readFile("./assets/scramjet-mini-noalpha.png")
  .catch(() => null);
const commit = gitOutput(["rev-parse", "--short", "HEAD"], "unknown");
const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], "detached");
const version: string = await fs
  .readFile("./package.json", "utf-8")
  .then((raw) => JSON.parse(raw).version)
  .catch(() => "unknown");

const DEMO_PORT = Number(process.env.DEMO_PORT) || 4141;
const startedAt = Date.now();

// A per-boot random key silently invalidates open sessions on every restart.
// That's tolerable in dev, but it should not be a mystery when it happens.
const signingKey =
  process.env.SESSION_SECRET || randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  log("warn", "session_secret_missing", {
    detail: "using an ephemeral key; unlocks reset on every restart",
  });
}

// Behind Replit's edge the socket address is the proxy's, so x-forwarded-for is
// the only real client identity. Directly exposed, that same header is
// attacker-controlled and would let anyone mint a fresh rate-limit bucket per
// request — so it is trusted only when a proxy is known to be in front.
const TRUST_PROXY =
  process.env.TRUST_PROXY === "1" || Boolean(process.env.REPLIT_DEV_DOMAIN);

const accessLimiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 5 * 60_000,
  maxEntries: 5_000,
});
const upgradeLimiter = new FixedWindowRateLimiter({
  limit: 120,
  windowMs: 60_000,
  maxEntries: 5_000,
});

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    // The response depends on the cookie; without this a shared cache
    // could hand one visitor's unlocked state to another.
    Vary: "Cookie",
    ...headers,
  });
  response.end(payload);
}

function secureCookie(request: http.IncomingMessage) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "");
  const secure =
    forwardedProtocol === "https" || Boolean(process.env.REPLIT_DEV_DOMAIN);

  // No Max-Age/Expires on purpose: this is a browser-session cookie.
  return buildSetCookie(issueAccessToken(signingKey), secure);
}

// A wisp URL is only pinned when the operator names one (or when Replit hands
// us its public domain). Otherwise wisp is served on this same port under
// /wisp/, and the correct URL is whatever origin the browser actually used —
// see requestWispUrl() below.
const EXPLICIT_WISP_URL = process.env.VITE_WISP_URL
  ? normalizeWebsocketUrl(process.env.VITE_WISP_URL)
  : process.env.REPLIT_DEV_DOMAIN
    ? `wss://${process.env.REPLIT_DEV_DOMAIN}/wisp/`
    : null;

// Vite bakes VITE_* into the client bundle at build time, so only export it
// when it is genuinely a fixed address; otherwise store.ts computes the
// same-origin URL in the browser, where the answer is actually knowable.
if (EXPLICIT_WISP_URL) {
  process.env.VITE_WISP_URL = EXPLICIT_WISP_URL;
} else {
  delete process.env.VITE_WISP_URL;
}

// The wisp URL handed to the browser has to be one the *browser* can open,
// and when wisp is not pinned to a fixed address this server cannot work out
// what that is. It only sees the request as it arrives after every hop:
//
//   - a boot-time `ws://localhost:${DEMO_PORT}/wisp/` names the *viewer's* own
//     machine whenever the page is reached over anything but this host;
//   - deriving `${host}/wisp/` from the Host header is wrong wherever a tunnel
//     rewrites it — a Codespaces/dev-tunnel forwarded port answers an https
//     page while presenting the local `localhost:PORT` origin downstream, so
//     the browser got handed a ws:// URL for a host it cannot route to, and
//     blocked it as mixed content besides;
//   - x-forwarded-proto is absent on those same raw TCP tunnels, so http vs
//     https could not be recovered from the request either.
//
// Both transports connect lazily, so a URL that can never open used to sail
// through startup and resurface much later as "websocket did not open" on
// whatever page the user tried to browse to; probing at init (index.tsx) moved
// it forward to "Cannot reach the wisp server at ws://localhost:4141/wisp/".
//
// So stop guessing: answer with a *relative* path. Wisp is served from this
// same port under /wisp/, which makes the page's own origin the correct — and
// only guaranteed reachable — base, and the browser is the one party that
// knows it. index.tsx resolves it against location.
const SAME_ORIGIN_WISP_PATH = "/wisp/";

function wispConfigUrl(): string {
  return EXPLICIT_WISP_URL ?? SAME_ORIGIN_WISP_PATH;
}

// Keep proxy requests off private and loopback networks by default. Enabling
// these options would turn the public preview into an SSRF surface.
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
// Same tuning as the production tunnel (wisp-server.ts). Without a connect
// timeout a blackholed destination pins a stream open until the OS gives up,
// and without stream caps one runaway page exhausts the dev box's file
// descriptors — both reproduce locally, so both are bounded locally.
wisp.options.connect_timeout_ms =
  Number(process.env.WISP_CONNECT_TIMEOUT_MS) || 10_000;
wisp.options.stream_limit_per_host =
  Number(process.env.WISP_STREAM_LIMIT_PER_HOST) || 64;
wisp.options.stream_limit_total =
  Number(process.env.WISP_STREAM_LIMIT_TOTAL) || 1_000;
wisp.options.dns_ttl = Number(process.env.WISP_DNS_TTL_MS) || 60_000;

let wispConnections = 0;
let totalWispConnections = 0;
let shuttingDown = false;

const server = await createServer({
  configFile: "./vite.config.ts",
  root: ".",
  server: {
    port: DEMO_PORT,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

const accessMiddleware = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  next: (error?: unknown) => void,
) => {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(header, value);
  }

  // Matching on the raw url meant "/api/access?x=1" missed both branches and
  // fell through to Vite's SPA fallback, which answers 200 with index.html.
  const pathname = (request.url ?? "").split("?")[0];

  // Parity with the production tunnel's /health, so one probe works against
  // either environment.
  if (pathname === "/api/health") {
    sendJson(response, shuttingDown ? 503 : 200, {
      status: shuttingDown ? "draining" : "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      wispConnections,
      totalWispConnections,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      version,
      commit,
      pid: process.pid,
    });

    return;
  }

  // Production serves this from api/wisp-config.ts (Vercel); the dev server
  // has to answer it too. Without this branch the request fell through to
  // Vite, which happily transformed api/wisp-config.ts and served it as a
  // browser module — a 200 whose body is JS, so resolveWispUrl() passed the
  // response.ok check and then died on response.json(). That only degraded
  // gracefully on localhost, because the client's dev fallback is gated on
  // location.hostname; reached over any other host (a Codespaces forwarded
  // URL, a LAN IP, a tunnel) it threw instead, and init() burned all four
  // attempts before showing "Scramjet could not start".
  if (pathname === "/api/wisp-config") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Cookie");

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Method not allowed" });

      return;
    }

    if (!hasValidAccessCookie(signingKey, request.headers)) {
      sendJson(response, 401, { error: "Unlock the workspace first." });

      return;
    }

    // The dev wisp handler routes on a "/wisp/" prefix and ignores whatever
    // follows, so unlike production there is no secret to mint here — the
    // token is a placeholder that keeps the client's URL shape identical
    // across environments. wispUrl is relative unless an operator pinned one;
    // see wispConfigUrl() for why this server must not resolve it itself.
    sendJson(response, 200, {
      wispUrl: wispConfigUrl(),
      token: "dev",
    });

    return;
  }

  if (pathname !== "/api/access") {
    // Vite's job is to serve the client bundle, but its module graph will
    // happily transform and serve *any* source file under the project root
    // on request — including server-only modules that merely happen to live
    // here. Two things fall out of that, and both have bitten already:
    //
    //  1. Disclosure: /api/_lib/session.ts handed the browser the cookie
    //     signing and password verification logic. Values stay symbolic
    //     (`process.env.X` is not inlined), so no secret leaks, but the
    //     auth implementation shouldn't be a public download either.
    //  2. Wrong-answer-with-200: an unhandled /api/* route returned a
    //     JS module body with a 200 status, so callers that check
    //     `response.ok` before parsing JSON saw success and then failed on
    //     the parse. That is precisely how /api/wisp-config broke.
    //
    // Answering 404 here keeps unhandled API routes honest and stops the
    // server source from being reachable at all.
    if (pathname.startsWith("/api/") || SERVER_ONLY_MODULES.has(pathname)) {
      sendJson(response, 404, { error: "Not found" });

      return;
    }

    next();

    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, {
      unlocked: hasValidAccessCookie(signingKey, request.headers),
    });

    return;
  }

  if (request.method !== "POST") {
    sendJson(
      response,
      405,
      { error: "Method not allowed." },
      { Allow: "GET, POST" },
    );

    return;
  }

  const address = clientAddress(
    request.headers,
    request.socket.remoteAddress,
    TRUST_PROXY,
  );
  const limit = accessLimiter.check(address);
  if (!limit.allowed) {
    sendJson(
      response,
      429,
      { error: "Too many attempts. Try again shortly." },
      { "Retry-After": String(limit.retryAfterSeconds) },
    );

    return;
  }

  try {
    const body = await readJsonBody<{ password?: unknown }>(request);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!verifyPassword(password)) {
      const remaining = accessLimiter.record(address).remaining;
      log("warn", "access_denied", { address, remaining });
      sendJson(response, 401, { error: "Access denied." });

      return;
    }

    accessLimiter.reset(address);
    log("info", "access_granted", { address });
    sendJson(
      response,
      200,
      { unlocked: true },
      { "Set-Cookie": secureCookie(request) },
    );
  } catch (error) {
    const status = error instanceof BodyReadError ? error.status : 400;
    // Connection: close because the request body was left unread; Node
    // must not try to reuse this connection for a follow-up request.
    sendJson(
      response,
      status,
      { error: "Invalid access request." },
      { Connection: "close" },
    );
  }
};

// Vite's SPA fallback is installed during createServer(). Put the access
// boundary in front of it so /api/access can never be rewritten to index.html.
const middlewareStack = server.middlewares.stack as Array<{
  route: string;
  handle: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
}>;
middlewareStack.unshift({ route: "", handle: accessMiddleware });

warnOnUrlEscape(server);

await server.listen();

// Attach Wisp WebSocket handler to the Vite HTTP server on /wisp/ path.
// This lets the browser reach it via the same public port (5000).
server.httpServer?.on("upgrade", (req, rawSocket, head) => {
  // Anything else on this port is Vite's own HMR socket — leave it alone.
  // Logged first, and for every upgrade: when the browser reports that it
  // "cannot reach the wisp server", the single most valuable fact is whether
  // its socket ever arrived here at all. A silent log meant a mixed-content
  // block, a wrong host and a dead tunnel all looked identical from the
  // server, and telling them apart was pure guesswork. Host and origin are
  // recorded because a tunnel that rewrites them is exactly how the browser
  // ends up aiming at an address that was never this server.
  log("info", "upgrade_request", {
    url: req.url,
    wisp: req.url?.startsWith("/wisp/") ?? false,
    host: req.headers.host,
    origin: req.headers.origin,
  });
  if (!req.url?.startsWith("/wisp/")) return;

  const socket = rawSocket as Socket;
  // The error listener has to be attached before anything else touches this
  // socket: an ECONNRESET arriving while we're still checking the cookie has
  // no handler otherwise, and an unhandled 'error' event kills the process.
  socket.on("error", (error) => {
    log("warn", "wisp_socket_error", { error: String(error) });
  });
  // Tunnelled traffic is latency-sensitive and mostly small frames; Nagle
  // batching adds up to ~40ms per write here for no benefit.
  socket.setNoDelay(true);
  // Same reasoning as wisp-server.ts: an idle tunnel whose peer has gone away
  // is indistinguishable from a healthy one without keep-alive probes, and it
  // holds a descriptor and a slot in the connection count forever.
  socket.setKeepAlive(true, 60_000);

  const reject = (status: string, reason: string) => {
    log("warn", "wisp_upgrade_rejected", { reason });
    // end() rather than write()-then-destroy(): destroy() does not wait for
    // the write to flush, so the client could get a connection reset instead
    // of the status line explaining the refusal.
    if (socket.writable) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    } else {
      socket.destroy();
    }
  };

  if (shuttingDown) return reject("503 Service Unavailable", "draining");

  const address = clientAddress(req.headers, socket.remoteAddress, TRUST_PROXY);
  if (!upgradeLimiter.check(address).allowed) {
    return reject("429 Too Many Requests", "rate_limited");
  }
  // Every attempt counts, accepted ones included — same reasoning as
  // wisp-server.ts: metering only the rejections leaves the limiter unable to
  // bound anything a valid credential can do.
  upgradeLimiter.record(address);
  if (!hasValidAccessCookie(signingKey, req.headers)) {
    return reject("401 Unauthorized", "no_access_cookie");
  }

  wispConnections++;
  totalWispConnections++;
  socket.once("close", () => {
    wispConnections--;
  });

  try {
    wisp.routeRequest(req, socket, head);
  } catch (error) {
    log("error", "wisp_route_failed", { error: String(error) });
    socket.destroy();
  }
});

// A dev server that dies on the first unhandled rejection from a proxied page
// takes the whole edit/reload loop with it. Log it and stay up instead.
process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", {
    error: String(error),
    stack: error.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { reason: String(reason) });
});

// Ctrl-C used to leave Vite's watchers, the HTTP server and every open tunnel to
// be reaped by process death, which regularly held the port long enough to fail
// the next `pnpm dev` with EADDRINUSE.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_start", { signal, wispConnections });

  const forceExit = setTimeout(() => {
    log("warn", "shutdown_forced", { signal });
    process.exit(0);
  }, 5_000);
  forceExit.unref();

  try {
    await server.close();
  } catch (error) {
    log("error", "shutdown_error", { error: String(error) });
  }
  clearTimeout(forceExit);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const accent = (text: string) => chalk.hex("#f1855bff").bold(text);
const highlight = (text: string) => chalk.hex("#fdd76cff").bold(text);
const urlColor = (text: string) => chalk.hex("#64DFDF").underline(text);
const note = (text: string) => chalk.hex("#CDB4DB")(text);
const connector = chalk.hex("#8D99AE").dim("@");

const lines = [
  black()(`${highlight("SCRAMJET DEV SERVER")}`),
  black()(
    `${accent("demo")} ${connector} ${urlColor(
      `http://localhost:${DEMO_PORT}/`,
    )}`,
  ),
  black()(
    `${accent("wisp")} ${connector} ${urlColor(
      EXPLICIT_WISP_URL ?? `ws://localhost:${DEMO_PORT}/wisp/`,
    )}${EXPLICIT_WISP_URL ? "" : chalk.dim(" (same-origin)")}`,
  ),
  black()(
    `${accent("health")} ${connector} ${urlColor(
      `http://localhost:${DEMO_PORT}/api/health`,
    )}`,
  ),
  black()(chalk.dim(`[${branch}] ${commit} scramjet/${version}`)),
];

if (image) {
  await printBanner(image, lines);
} else {
  for (const line of lines) console.log(line);
}

// runRspack(rspackConfig); // using pre-built release dist files
