import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { hashPassword, hashSecret, newToken } from "../api/_lib/auth-crypto.ts";
const destination = process.argv[2] ?? ".env.auth";
const silent = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const prompt = createInterface({
  input: process.stdin,
  output: silent,
  terminal: Boolean(process.stdin.isTTY),
});
async function ask(label: string) {
  process.stderr.write(label + ": ");
  const value = await prompt.question("");
  process.stderr.write("\n");
  return value;
}
try {
  const origin =
    process.env.AUTH_ORIGIN ||
    (await ask("Application origin (e.g. https://your-domain.example)"));
  const database =
    process.env.DATABASE_URL || (await ask("PostgreSQL DATABASE_URL (hidden)"));
  const password = await ask("Normal password (12+ characters, hidden)");
  if (password !== (await ask("Confirm normal password (hidden)")))
    throw new Error("Passwords do not match.");
  const admin = await ask("Different admin password (12+ characters, hidden)");
  if (
    admin !== (await ask("Confirm admin password (hidden)")) ||
    admin === password
  )
    throw new Error(
      "Administrator password must match its confirmation and differ from the normal password.",
    );
  const setup = newToken();
  const values = {
    AUTH_ORIGIN: origin,
    DATABASE_URL: database,
    ACCESS_PASSWORD_HASH: hashPassword(password),
    ADMIN_PASSWORD_HASH: hashPassword(admin),
    ADMIN_SETUP_TOKEN_HASH: hashSecret(setup),
    FACE_TEMPLATE_KEY: newToken(),
    SESSION_SECRET: newToken(),
  };
  if (Object.values(values).some((v) => /[\r\n']/.test(v)))
    throw new Error(
      "Configuration values cannot contain newlines or single quotes.",
    );
  await writeFile(
    destination,
    Object.entries(values)
      .map(([key, value]) => `${key}='${value}'`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(destination + ".setup-secret.txt", setup + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  process.stderr.write(
    `Saved private configuration to ${destination} and one-time setup secret to ${destination}.setup-secret.txt. Do not commit either file.\n`,
  );
} finally {
  prompt.close();
}
