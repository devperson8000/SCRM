import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { AuthService, migrateAuth } from "../api/_lib/auth-service.ts";
import { hashPassword, hashSecret } from "../api/_lib/auth-crypto.ts";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEST_DATABASE_URL is required for real PostgreSQL auth integration tests.",
  );
const pool = new pg.Pool({ connectionString: url, max: 8 });
const userPassword = randomBytes(16).toString("hex"),
  adminPassword = randomBytes(16).toString("hex"),
  setupToken = randomBytes(32).toString("hex");
const config = {
  userHash: hashPassword(userPassword),
  adminHash: hashPassword(adminPassword),
  setupHash: hashSecret(setupToken),
  templateKey: randomBytes(32),
  secret: randomBytes(32).toString("hex"),
  origin: "http://localhost:4141",
};
let descriptor = Array(128).fill(0.01);
const service = new AuthService(pool, config, async () => descriptor);
const address = "integration";
const call = (
  action: string,
  body: any = {},
  preauth?: string,
  session?: string,
) =>
  service.handle(
    action,
    body,
    { preauth, session },
    address + "-" + randomBytes(4).toString("hex"),
  );
const pre = async (password: string) => {
  const r = await call("password", { password });
  assert.equal(r.status, 200);
  assert.equal(r.body.unlocked, undefined);
  return r.preauth!;
};
const challenge = async (preauth: string, purpose: string, extra = {}) => {
  const r = await call("challenge", { purpose, ...extra }, preauth);
  assert.equal(r.status, 200);
  return r.body.challengeId;
};
let adminSession: string;
let userSession: string;
let pendingId: string;
let receipt: string;
let recoveryCodes: string[];
test.before(async () => {
  await migrateAuth(pool);
  await pool.query(
    "TRUNCATE auth_audit, auth_tokens, auth_users, auth_rate RESTART IDENTITY CASCADE",
  );
});
test.after(async () => pool.end());
test("regular password never creates an access session or permits bootstrap", async () => {
  const p = await pre(userPassword);
  assert.equal(await service.getSession(p, "user"), null);
  const r = await call("challenge", { purpose: "setup", setupToken }, p);
  assert.equal(r.status, 403);
});
test("admin setup requires separate setup secret and concurrent setup succeeds once", async () => {
  const p = await pre(adminPassword);
  assert.equal(
    (await call("challenge", { purpose: "setup", setupToken: "bad" }, p))
      .status,
    403,
  );
  const ids = await Promise.all([
    challenge(p, "setup", { setupToken }),
    challenge(p, "setup", { setupToken }),
  ]);
  const results = await Promise.all(
    ids.map((challengeId) => call("setup", { challengeId, images: [] }, p)),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.some((r) => r.status === 401 || r.status === 409));
  const ok = results.find((r) => r.status === 200)!;
  adminSession = ok.session!;
  assert.ok(ok.body.recoveryCodes.length === 8);
  recoveryCodes = ok.body.recoveryCodes;
  assert.equal(
    (
      await call(
        "challenge",
        { purpose: "setup", setupToken },
        await pre(adminPassword),
      )
    ).status,
    409,
  );
  assert.equal(await service.getSession(adminSession, "user"), null);
});
test("enrollment stays pending, no session, and challenge cannot be replayed", async () => {
  descriptor = Array(128).fill(0.1);
  const p = await pre(userPassword),
    id = await challenge(p, "enroll");
  const result = await call(
    "enroll",
    { challengeId: id, images: [], name: "Test person", consent: true },
    p,
  );
  assert.equal(result.status, 202);
  assert.equal(result.session, undefined);
  receipt = result.body.receipt;
  assert.equal(
    (
      await call(
        "enroll",
        { challengeId: id, images: [], name: "Replay", consent: true },
        p,
      )
    ).status,
    401,
  );
  const status = await call("status", { receipt });
  assert.equal(status.body.status, "pending");
  const login = await call(
    "login",
    { challengeId: await challenge(p, "login"), images: [] },
    p,
  );
  assert.equal(login.status, 401);
  const list = await call("admin-list", {}, undefined, adminSession);
  assert.equal(list.status, 200);
  const person = list.body.users.find((u: any) => u.name === "Test person");
  pendingId = person.id;
  assert.equal("template" in person, false);
});
test("non-admin sessions and forged role inputs cannot approve requests", async () => {
  const p = await pre(userPassword);
  assert.equal(
    (await call("admin-approve", { id: pendingId, role: "admin" }, p)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "admin-approve",
        { id: pendingId, role: "admin" },
        undefined,
        p,
      )
    ).status,
    403,
  );
});
test("admin approval enables fresh login and role-scoped sessions", async () => {
  assert.equal(
    (await call("admin-approve", { id: pendingId }, undefined, adminSession))
      .status,
    200,
  );
  const p = await pre(userPassword);
  const result = await call(
    "login",
    { challengeId: await challenge(p, "login"), images: [] },
    p,
  );
  assert.equal(result.status, 200);
  userSession = result.session!;
  assert.ok(await service.getSession(userSession, "user"));
  assert.equal(await service.getSession(userSession, "admin"), null);
  assert.equal(
    (await call("admin-list", {}, undefined, userSession)).status,
    403,
  );
  const adminPre = await pre(adminPassword);
  const failed = await call(
    "login",
    { challengeId: await challenge(adminPre, "login"), images: [] },
    adminPre,
  );
  assert.equal(failed.status, 401);
});
test("revocation removes the template and invalidates sessions and Wisp identity", async () => {
  const identity = await service.getSession(userSession, "user");
  assert.equal(
    (await call("admin-revoke", { id: pendingId }, undefined, adminSession))
      .status,
    200,
  );
  assert.equal(await service.getSession(userSession, "user"), null);
  assert.equal(await service.activeUserSession(identity!.id), false);
  const row = await pool.query("SELECT template FROM auth_users WHERE id=$1", [
    pendingId,
  ]);
  assert.equal(row.rows[0].template, null);
});
test("expired and cross-purpose challenges fail closed", async () => {
  const p = await pre(userPassword),
    id = await challenge(p, "login");
  assert.equal(
    (
      await call(
        "enroll",
        { challengeId: id, images: [], name: "x", consent: true },
        p,
      )
    ).status,
    401,
  );
  const expired = await challenge(p, "login");
  await pool.query(
    "UPDATE auth_tokens SET expires=now()-interval '1 second' WHERE data->>'id'=$1",
    [expired],
  );
  assert.equal(
    (await call("login", { challengeId: expired, images: [] }, p)).status,
    401,
  );
});
test("admin recovery requires an unused code and replaces sessions and recovery codes", async () => {
  const preauth = await pre(adminPassword);
  assert.equal(
    (
      await call(
        "challenge",
        { purpose: "recover", recoveryCode: "invalid" },
        preauth,
      )
    ).status,
    403,
  );
  const code = recoveryCodes[0];
  const id = await challenge(preauth, "recover", { recoveryCode: code });
  assert.equal(
    (
      await call(
        "challenge",
        { purpose: "recover", recoveryCode: code },
        preauth,
      )
    ).status,
    403,
  );
  descriptor = Array(128).fill(0.2);
  const result = await call(
    "recover",
    { challengeId: id, images: [], consent: true },
    preauth,
  );
  assert.equal(result.status, 200);
  assert.equal(await service.getSession(adminSession, "admin"), null);
  assert.ok(await service.getSession(result.session, "admin"));
  assert.equal(result.body.recoveryCodes.length, 8);
  const fresh = await pre(adminPassword);
  assert.equal(
    (
      await call(
        "challenge",
        { purpose: "recover", recoveryCode: recoveryCodes[1] },
        fresh,
      )
    ).status,
    403,
  );
});

test("durable password throttle survives a new service instance", async () => {
  for (let i = 0; i < 5; i++)
    await service.handle("password", { password: "wrong" }, {}, "attacker");
  const other = new AuthService(pool, config, async () => descriptor);
  assert.equal(
    (await other.handle("password", { password: userPassword }, {}, "attacker"))
      .status,
    429,
  );
});
test("legacy cookies and invented tokens cannot grant sessions", async () => {
  assert.equal(
    await service.getSession("1700000000000.nonce.signature", "user"),
    null,
  );
  assert.equal(
    await service.getSession(randomBytes(32).toString("hex"), "admin"),
    null,
  );
});

test("an in-flight recovery cannot override a completed recovery rotation", async () => {
  const preA = await pre(adminPassword),
    preB = await pre(adminPassword);
  // Create fresh recovery codes for the test owner without exposing their values.
  const admin = await pool.query(
    "SELECT id FROM auth_users WHERE role='admin'",
  );
  const codeA = randomBytes(32).toString("hex"),
    codeB = randomBytes(32).toString("hex");
  for (const code of [codeA, codeB])
    await pool.query(
      "INSERT INTO auth_tokens(hash,kind,role,user_id,expires) VALUES($1,'recovery','admin',$2,now()+interval '1 day')",
      [hashSecret(code), admin.rows[0].id],
    );
  const idA = await challenge(preA, "recover", { recoveryCode: codeA }),
    idB = await challenge(preB, "recover", { recoveryCode: codeB });
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (started = r));
  const slow = new AuthService(pool, config, async () => {
    started();
    await blocked;
    return Array(128).fill(0.3);
  });
  const stale = slow.handle(
    "recover",
    { challengeId: idB, images: [], consent: true },
    { preauth: preB },
    "race-b",
  );
  await ready;
  descriptor = Array(128).fill(0.25);
  const first = await call(
    "recover",
    { challengeId: idA, images: [], consent: true },
    preA,
  );
  assert.equal(first.status, 200);
  release();
  const second = await stale;
  assert.equal(second.status, 401);
  assert.ok(await service.getSession(first.session, "admin"));
});

test("logout invalidates sessions issued by an overlapping login using the same preauth", async () => {
  const p = await pre(adminPassword),
    id = await challenge(p, "login");
  descriptor = Array(128).fill(0.25);
  const login = await call("login", { challengeId: id, images: [] }, p);
  assert.equal(login.status, 200);
  // The browser's concurrent logout started with the preauth cookie, before it
  // received the new session cookie from this login.
  assert.equal((await call("logout", {}, p)).status, 200);
  assert.equal(await service.getSession(login.session, "admin"), null);
});
