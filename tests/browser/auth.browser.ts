import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { AuthService, migrateAuth } from "../../api/_lib/auth-service.ts";
import { accessHandler, adminHandler } from "../../api/_lib/auth-http.ts";
import { hashPassword, hashSecret } from "../../api/_lib/auth-crypto.ts";
const { chromium } = createRequire(
  new URL("../../runway/package.json", import.meta.url),
)("playwright");
if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "TEST_DATABASE_URL must name a disposable PostgreSQL database.",
  );
const origin = process.env.AUTH_BROWSER_ORIGIN ?? "http://127.0.0.1:4143";
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: "-c search_path=scrm_browser",
});
const master = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
await master.query("CREATE SCHEMA IF NOT EXISTS scrm_browser");
await master.end();
await migrateAuth(pool);
await pool.query(
  "TRUNCATE auth_audit,auth_tokens,auth_users,auth_rate CASCADE",
);
const adminPassword = randomBytes(16).toString("hex"),
  userPassword = randomBytes(16).toString("hex"),
  setupToken = randomBytes(32).toString("hex");
let descriptor = Array(128).fill(0.01);
// Intentionally mocked capture verification: this test proves UI/authorization,
// not recognition accuracy. Real model validation is a separate requirement.
const config = {
  origin,
  userHash: hashPassword(userPassword),
  adminHash: hashPassword(adminPassword),
  setupHash: hashSecret(setupToken),
  templateKey: randomBytes(32),
  secret: randomBytes(32).toString("hex"),
};
const service = new AuthService(pool, config, async (images) => {
  assert.equal(images.length, 6);
  return descriptor;
});
const server = createServer(
  (req, res) =>
    void (req.url === "/api/admin" ? adminHandler : accessHandler)(
      req,
      res,
      service,
    ),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const backend = "http://127.0.0.1:" + (server.address() as any).port;
const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
databaseUrl.searchParams.set("options", "-c search_path=scrm_browser");
const dev = spawn(process.execPath, ["devserver.ts"], {
  cwd: process.cwd(),
  stdio: "ignore",
  env: {
    ...process.env,
    CI: "1",
    DEMO_PORT: new URL(origin).port,
    AUTH_ORIGIN: origin,
    DATABASE_URL: databaseUrl.toString(),
    ACCESS_PASSWORD_HASH: config.userHash,
    ADMIN_PASSWORD_HASH: config.adminHash,
    ADMIN_SETUP_TOKEN_HASH: config.setupHash,
    FACE_TEMPLATE_KEY: config.templateKey.toString("hex"),
    SESSION_SECRET: config.secret,
  },
});
let ready = false;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(origin + "/api/health")).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
if (!ready) {
  dev.kill();
  throw new Error("Test development server did not start.");
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
async function pageFor() {
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();
  await page.route("**/api/access", async (route: any) => {
    const response = await route.fetch({ url: backend + "/api/access" });
    await route.fulfill({ response });
  });
  await page.route("**/api/admin", async (route: any) => {
    const response = await route.fetch({ url: backend + "/api/admin" });
    await route.fulfill({ response });
  });
  page.on("pageerror", (e: Error) =>
    console.error("Browser error:", e.message),
  );
  await page.goto(origin);
  return page;
}
async function password(page: any, value: string) {
  await page.getByLabel("Workspace password").fill(value);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
try {
  const admin = await pageFor();
  await password(admin, adminPassword);
  await admin
    .getByRole("button", { name: "Enroll administrator face" })
    .click();
  await admin.getByLabel("One-time setup secret").fill(setupToken);
  await admin.getByRole("checkbox").check();
  await admin.getByRole("button", { name: "Start face enrollment" }).click();
  await admin
    .getByRole("heading", { name: "Admin Panel", exact: true })
    .waitFor({ timeout: 25000 });
  assert.equal(
    await admin
      .getByRole("textbox", { name: "Recovery codes" })
      .inputValue()
      .then((v: string) => v.split("\n").length),
    8,
  );
  console.log(
    "PASS admin password + one-time setup + camera flow opens Admin Panel (mocked face verifier)",
  );
  descriptor = Array(128).fill(0.1);
  const user = await pageFor();
  await password(user, userPassword);
  await user
    .getByRole("button", { name: "Enrol your face", exact: true })
    .click();
  await user.getByLabel("Your name").fill("Browser test user");
  await user.getByRole("checkbox").check();
  await user.getByRole("button", { name: "Start face enrollment" }).click();
  await user
    .getByRole("heading", { name: "Awaiting approval" })
    .waitFor({ timeout: 25000 });
  assert.equal(await user.locator(".browser-frame").count(), 0);
  console.log("PASS enrollment remains pending and never starts the proxy");
  await admin.getByRole("button", { name: "Refresh requests" }).click();
  await admin.getByRole("button", { name: "Approve", exact: true }).click();
  await user.getByRole("button", { name: "Check approval" }).click();
  await user
    .getByRole("button", { name: "Return to login", exact: true })
    .click();
  await password(user, userPassword);
  await user.getByRole("button", { name: "Scan my face", exact: true }).click();
  await user.waitForFunction(
    () => sessionStorage.getItem("scramjet-access-session") === "granted",
    { timeout: 25000 },
  );
  const status = await user.evaluate(() =>
    fetch("/api/access").then((r) => r.json()),
  );
  assert.equal(status.unlocked, true);
  console.log("PASS admin approval allows a fresh password + camera login");
  await admin.getByRole("button", { name: "Refresh requests" }).click();
  admin.once("dialog", (d: any) => d.accept());
  await admin
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await admin.getByText(/revoked · Requested/).waitFor();
  assert.equal(
    (await user.evaluate(() => fetch("/api/access").then((r) => r.json())))
      .unlocked,
    false,
  );
  console.log("PASS admin revocation invalidates the user session");
  const cancel = await pageFor();
  await password(cancel, userPassword);
  await cancel
    .getByRole("button", { name: "Scan my face", exact: true })
    .click();
  await cancel.locator("video").waitFor();
  await cancel.getByRole("button", { name: "Cancel scan" }).click();
  assert.equal(await cancel.locator("video").count(), 0);
  console.log("PASS scan cancellation removes camera UI");
} catch (error) {
  for (const page of browser.contexts().flatMap((c: any) => c.pages()))
    console.error(
      "UI status:",
      await page.locator(".face-status").allTextContents(),
    );
  throw error;
} finally {
  dev.kill();
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
