import { writeFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
try {
  await access(".env.auth");
  throw new Error(
    ".env.auth already exists. Reuse it; do not overwrite your keys or admin database.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const password = randomBytes(32).toString("hex");
await writeFile(".env.auth.db", `POSTGRES_PASSWORD=${password}\n`, {
  mode: 0o600,
  flag: "wx",
});
const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    ".env.auth.db",
    "-f",
    "compose.auth.yaml",
    "up",
    "-d",
    "--wait",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0)
  throw new Error(
    "Could not start PostgreSQL. Inspect Docker, then follow the manual setup in FACE_AUTH_SETUP.md.",
  );
const config = spawnSync(process.execPath, ["scripts/auth-config.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AUTH_ORIGIN: "http://localhost:4141",
    DATABASE_URL: `postgresql://scramjet:${password}@127.0.0.1:5432/scramjet_auth`,
  },
});
if (config.status !== 0) process.exit(config.status ?? 1);
const migrate = spawnSync(
  process.execPath,
  ["--env-file=.env.auth", "scripts/auth-migrate.ts"],
  { stdio: "inherit" },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
console.log(
  "Local authentication is configured. Run pnpm auth:dev, then open http://localhost:4141. Your one-time admin setup secret is in .env.auth.setup-secret.txt.",
);
