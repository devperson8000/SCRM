import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
export const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("hex");
export function hashPassword(password: string): string {
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 512)
    throw new Error("Passwords must contain 12–512 bytes.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$16384$${salt}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}
export function validPasswordHash(hash: string): boolean {
  return /^scrypt\$16384\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(hash);
}
export function verifyPasswordHash(password: string, hash: string): boolean {
  if (
    !validPasswordHash(hash) ||
    typeof password !== "string" ||
    Buffer.byteLength(password) > 512
  )
    return false;
  const parts = hash.split("$");
  return timingSafeEqual(
    scryptSync(password, parts[2], 32, { N: 16384, r: 8, p: 1 }),
    Buffer.from(parts[3], "hex"),
  );
}
export function seal(value: unknown, key: Buffer, id: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string, key: Buffer, id: string): number[] {
  const [iv, tag, data] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  );
}
export function signWisp(
  sessionId: string,
  secret: string,
  now = Date.now(),
): string {
  const data = Buffer.from(
    JSON.stringify({ v: 2, sid: sessionId, exp: now + 60_000 }),
  ).toString("base64url");
  return (
    data + "." + createHmac("sha256", secret).update(data).digest("base64url")
  );
}
export function readWisp(
  token: string | null,
  secret: string,
  now = Date.now(),
): string | null {
  try {
    if (!token || token.length > 400) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const signature = Buffer.from(parts[1], "base64url"),
      expected = createHmac("sha256", secret).update(parts[0]).digest();
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    )
      return null;
    const data = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    return data.v === 2 &&
      /^[a-f0-9]{64}$/.test(data.sid) &&
      Number.isFinite(data.exp) &&
      data.exp > now &&
      data.exp <= now + 60_000
      ? data.sid
      : null;
  } catch {
    return null;
  }
}
