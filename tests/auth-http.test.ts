import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { accessHandler, adminHandler } from "../api/_lib/auth-http.ts";
import { signWisp, readWisp } from "../api/_lib/auth-crypto.ts";

test("Wisp rejects old unbound tokens, altered tokens, and expiration", () => {
  const id = "a".repeat(64),
    key = "test-secret";
  const token = signWisp(id, key, 1000);
  assert.equal(readWisp(token, key, 1001), id);
  assert.equal(readWisp(token, key, 61_000), null);
  assert.equal(readWisp(token + "x", key, 1001), null);
  assert.equal(readWisp("1700000000000." + "a".repeat(64), key), null);
});

test("HTTP routes reject cross-origin mutations before touching authentication", async () => {
  let calls = 0;
  const service: any = {
    config: { origin: "http://localhost:4141" },
    handle: async () => {
      calls++;
      return { status: 200, body: { role: "user" }, preauth: "a".repeat(64) };
    },
  };
  const server = createServer(
    (req, res) =>
      void (req.url === "/api/admin" ? adminHandler : accessHandler)(
        req,
        res,
        service,
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    for (const origin of [undefined, "https://attacker.example"]) {
      const headers: any = { "Content-Type": "application/json" };
      if (origin) headers.Origin = origin;
      const r = await fetch(base + "/api/access", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "password", password: "secret" }),
      });
      assert.equal(r.status, 403);
    }
    assert.equal(calls, 0);
    const r = await fetch(base + "/api/access", {
      method: "POST",
      headers: {
        Origin: "http://localhost:4141",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "password", password: "secret" }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie")!, /scramjet_preauth/);
    assert.doesNotMatch(r.headers.get("set-cookie")!, /scramjet_access/);
    const admin = await fetch(base + "/api/admin", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: '{"action":"approve"}',
    });
    assert.equal(admin.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP rejects oversized/non-object inputs and disables caching", async () => {
  let calls = 0;
  const service: any = {
    config: { origin: "http://localhost:4141" },
    handle: async () => {
      calls++;
      return { status: 200, body: { unlocked: false } };
    },
  };
  const server = createServer(
    (req, res) => void accessHandler(req, res, service),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    for (const body of [
      "[]",
      JSON.stringify({ action: "password", extra: "x".repeat(900001) }),
    ]) {
      const r = await fetch(base + "/api/access", {
        method: "POST",
        headers: {
          Origin: "http://localhost:4141",
          "Content-Type": "application/json",
        },
        body,
      });
      assert.ok([400, 413].includes(r.status));
    }
    assert.equal(calls, 0);
    const r = await fetch(base + "/api/access");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(
      r.headers.get("permissions-policy"),
      "camera=(self), microphone=(), geolocation=(), payment=()",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revocation watcher disconnects an open socket and stops after close", async () => {
  const { watchAuthorizedSocket } = await import("../api/_lib/auth-wisp.ts");
  const { EventEmitter } = await import("node:events");
  const socket: any = new EventEmitter();
  let destroyed = false;
  let active = true;
  socket.destroy = () => {
    destroyed = true;
    socket.emit("close");
  };
  watchAuthorizedSocket(socket, async () => active, 10);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(destroyed, false);
  active = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(destroyed, true);
});
