import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthService, type AuthService } from "./auth-service.ts";
import { readCookie, clientAddress, SECURITY_HEADERS } from "./session.ts";
export { getAuthService } from "./auth-service.ts";
export { signWisp, readWisp } from "./auth-crypto.ts";
export const ACCESS_COOKIE_V4 = "scramjet_access_v4";
export const PREAUTH_COOKIE = "scramjet_preauth_v1";
export function authCookies(headers: IncomingMessage["headers"]) {
  return {
    session: readCookie(headers.cookie, ACCESS_COOKIE_V4) ?? undefined,
    preauth: readCookie(headers.cookie, PREAUTH_COOKIE) ?? undefined,
  };
}
function cookie(name: string, value: string, secure: boolean, maxAge?: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}${maxAge === undefined ? "" : "; Max-Age=" + maxAge}`;
}
export async function parseAuthBody(req: IncomingMessage & { body?: unknown }) {
  const max = 900_000;
  if (req.body !== undefined) {
    const body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > max)
      throw Object.assign(new Error("Request too large."), { status: 413 });
    const value = JSON.parse(body);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error("Expected a JSON object.");
    return value;
  }
  if (
    !String(req.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new Error("Use application/json.");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max)
    throw Object.assign(new Error("Request too large."), { status: 413 });
  req.setTimeout(10_000, () => req.destroy());
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max)
      throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  req.setTimeout(0);
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Expected a JSON object.");
  return value;
}
export function sendAuth(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  admin: boolean,
  supplied?: AuthService,
) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    res.setHeader(key, value);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie");
  let service: AuthService;
  try {
    service = supplied ?? getAuthService();
  } catch (error) {
    // Keep secrets out of the client response, but log the validation reason
    // so deployment configuration mistakes can be diagnosed in Vercel logs.
    console.error("[auth] Failed to initialise authentication:", error instanceof Error ? error.message : "Unknown configuration error");
    sendAuth(res, 503, {
      error:
        "Face login is not configured. See FACE_AUTH_SETUP.md for required database, keys, passwords and migration.",
    });
    return;
  }
  const method = req.method ?? "";
  if (
    !["GET", "POST", "DELETE"].includes(method) ||
    (admin && method === "DELETE")
  ) {
    res.setHeader("Allow", admin ? "GET, POST" : "GET, POST, DELETE");
    sendAuth(res, 405, { error: "Method not allowed." });
    return;
  }
  if (method !== "GET" && req.headers.origin !== service.config.origin) {
    sendAuth(res, 403, { error: "Request origin is not allowed." });
    return;
  }
  let body: any = {};
  if (method === "POST")
    try {
      body = await parseAuthBody(req);
    } catch (error) {
      sendAuth(res, (error as any).status ?? 400, {
        error: "Invalid or oversized authentication request.",
      });
      return;
    }
  const action = admin
    ? method === "GET"
      ? "admin-list"
      : "admin-" + body.action
    : method === "GET"
      ? "session"
      : method === "DELETE"
        ? "logout"
        : (body.action ?? "password");
  const allowed = admin
    ? [
        "admin-list",
        "admin-approve",
        "admin-reject",
        "admin-revoke",
        "admin-delete",
      ]
    : [
        "session",
        "logout",
        "password",
        "challenge",
        "login",
        "enroll",
        "status",
        "setup",
        "recover",
      ];
  if (!allowed.includes(action)) {
    sendAuth(res, 400, { error: "Unknown authentication action." });
    return;
  }
  const credentials = authCookies(req.headers);
  const address = clientAddress(
    req.headers,
    req.socket.remoteAddress,
    process.env.VERCEL === "1" || process.env.TRUST_PROXY === "1",
  );
  try {
    const result = await service.handle(action, body, credentials, address);
    const secure = service.config.origin.startsWith("https:");
    const cookies: string[] = [];
    if (result.preauth)
      cookies.push(cookie(PREAUTH_COOKIE, result.preauth, secure, 300));
    if (result.session) {
      cookies.push(cookie(ACCESS_COOKIE_V4, result.session, secure));
      cookies.push(cookie(PREAUTH_COOKIE, "", secure, 0));
    }
    if (result.clear) {
      cookies.push(cookie(ACCESS_COOKIE_V4, "", secure, 0));
      cookies.push(cookie(PREAUTH_COOKIE, "", secure, 0));
    }
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    if (result.status === 429) res.setHeader("Retry-After", "300");
    sendAuth(res, result.status, result.body);
  } catch {
    sendAuth(res, 503, {
      error:
        "Authentication is temporarily unavailable. No access was granted.",
    });
  }
}
export const accessHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  service?: AuthService,
) => handle(req, res, false, service);
export const adminHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  service?: AuthService,
) => handle(req, res, true, service);
