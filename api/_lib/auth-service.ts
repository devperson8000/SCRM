import pg from "pg";
import { randomUUID, randomInt, createHmac } from "node:crypto";
import {
  hashSecret,
  newToken,
  verifyPasswordHash,
  validPasswordHash,
  seal,
  unseal,
} from "./auth-crypto.ts";
import { faceDistance, FACE_THRESHOLD, verifyCapture } from "./face.ts";

export type AuthConfig = {
  userHash: string;
  adminHash: string;
  setupHash: string;
  templateKey: Buffer;
  secret: string;
  origin: string;
};
type Credentials = { preauth?: string; session?: string };
type Result = {
  status: number;
  body: Record<string, any>;
  preauth?: string;
  session?: string;
  clear?: boolean;
};
export type AuthSession = {
  id: string;
  userId: string;
  role: "user" | "admin";
  name: string;
};
class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const deny = (status: number, message: string): never => {
  throw new AuthError(status, message);
};
const tokenHash = (value?: string) =>
  value && /^[a-f0-9]{64}$/.test(value) ? hashSecret(value) : "";

export async function migrateAuth(pool: pg.Pool) {
  await pool.query(`
 CREATE TABLE IF NOT EXISTS auth_users (id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), role text NOT NULL CHECK(role IN ('user','admin')), status text NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')), template text, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now());
 ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
 ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS review_photo text;
 CREATE UNIQUE INDEX IF NOT EXISTS auth_single_admin ON auth_users(role) WHERE role='admin';
 CREATE TABLE IF NOT EXISTS auth_tokens (hash text PRIMARY KEY, kind text NOT NULL, role text, user_id uuid REFERENCES auth_users(id) ON DELETE CASCADE, data jsonb NOT NULL DEFAULT '{}', expires timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS auth_tokens_expiration ON auth_tokens(expires);
 CREATE TABLE IF NOT EXISTS auth_rate (key text PRIMARY KEY, count integer NOT NULL, expires timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_audit (id bigserial PRIMARY KEY, actor uuid, action text NOT NULL, target uuid, created timestamptz NOT NULL DEFAULT now());
 `);
}

export function readAuthConfig(): AuthConfig {
  const required = [
    "DATABASE_URL",
    "ACCESS_PASSWORD_HASH",
    "ADMIN_PASSWORD_HASH",
    "ADMIN_SETUP_TOKEN_HASH",
    "FACE_TEMPLATE_KEY",
    "SESSION_SECRET",
    "AUTH_ORIGIN",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length)
    throw new Error(
      "Face login is not configured. Set " +
        missing.join(", ") +
        ". See FACE_AUTH_SETUP.md.",
    );
  if (
    !validPasswordHash(process.env.ACCESS_PASSWORD_HASH!) ||
    !validPasswordHash(process.env.ADMIN_PASSWORD_HASH!) ||
    process.env.ACCESS_PASSWORD_HASH === process.env.ADMIN_PASSWORD_HASH
  )
    throw new Error(
      "Configure distinct scrypt password hashes with the auth-config script.",
    );
  if (
    !/^[a-f0-9]{64}$/.test(process.env.FACE_TEMPLATE_KEY!) ||
    !/^[a-f0-9]{64}$/.test(process.env.ADMIN_SETUP_TOKEN_HASH!) ||
    process.env.SESSION_SECRET!.length < 32
  )
    throw new Error("Invalid authentication key configuration.");
  const origin = new URL(process.env.AUTH_ORIGIN!);
  if (
    origin.origin !== process.env.AUTH_ORIGIN ||
    (origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(origin.hostname))
  )
    throw new Error(
      "AUTH_ORIGIN must be an exact HTTPS origin (localhost allowed for development).",
    );
  return {
    userHash: process.env.ACCESS_PASSWORD_HASH!,
    adminHash: process.env.ADMIN_PASSWORD_HASH!,
    setupHash: process.env.ADMIN_SETUP_TOKEN_HASH!,
    templateKey: Buffer.from(process.env.FACE_TEMPLATE_KEY!, "hex"),
    secret: process.env.SESSION_SECRET!,
    origin: origin.origin,
  };
}

export class AuthService {
  pool: pg.Pool;
  config: AuthConfig;
  verify: typeof verifyCapture;
  constructor(pool: pg.Pool, config: AuthConfig, verify = verifyCapture) {
    this.pool = pool;
    this.config = config;
    this.verify = verify;
  }
  async throttle(
    address: string,
    action: string,
    limit: number,
    windowMs = 300_000,
  ) {
    const key = createHmac("sha256", this.config.secret)
      .update(action + ":" + address)
      .digest("hex");
    const r = await this.pool.query(
      `INSERT INTO auth_rate(key,count,expires) VALUES($1,1,now()+($2*interval '1 millisecond')) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate.expires<now() THEN 1 ELSE auth_rate.count+1 END, expires=CASE WHEN auth_rate.expires<now() THEN EXCLUDED.expires ELSE auth_rate.expires END RETURNING count`,
      [key, windowMs],
    );
    if (r.rows[0].count > limit)
      deny(429, "Too many attempts. Try again later.");
  }
  async createToken(
    kind: string,
    role: string | null,
    userId: string | null,
    data: unknown,
    ttl: number,
    db: pg.Pool | pg.PoolClient = this.pool,
  ) {
    const raw = newToken();
    await db.query(
      `INSERT INTO auth_tokens(hash,kind,role,user_id,data,expires) VALUES($1,$2,$3,$4,$5,now()+($6*interval '1 millisecond'))`,
      [hashSecret(raw), kind, role, userId, JSON.stringify(data), ttl],
    );
    return raw;
  }
  async getSession(
    raw: string | undefined,
    role?: string,
  ): Promise<AuthSession | null> {
    const r = await this.pool.query(
      `SELECT t.hash AS id,u.id AS "userId",u.role,u.name FROM auth_tokens t JOIN auth_users u ON t.user_id=u.id WHERE t.hash=$1 AND t.kind='session' AND t.expires>now() AND u.status='approved' AND ($2::text IS NULL OR u.role=$2)`,
      [tokenHash(raw), role ?? null],
    );
    return r.rows[0] ?? null;
  }
  async activeUserSession(id: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM auth_tokens t JOIN auth_users u ON t.user_id=u.id WHERE t.hash=$1 AND t.kind='session' AND t.expires>now() AND u.role='user' AND u.status='approved'`,
      [id],
    );
    return !!r.rowCount;
  }
  async cleanup() {
    await this.pool.query(
      `UPDATE auth_users SET status='rejected',template=NULL,review_photo=NULL,updated=now() WHERE status='pending' AND created<now()-interval '7 days'`,
    );
    await this.pool.query("DELETE FROM auth_tokens WHERE expires<now()");
    await this.pool.query("DELETE FROM auth_rate WHERE expires<now()");
  }
  async preauth(raw?: string) {
    const r = await this.pool.query(
      `SELECT * FROM auth_tokens WHERE hash=$1 AND kind='preauth' AND expires>now()`,
      [tokenHash(raw)],
    );
    return r.rows[0] ?? deny(401, "Enter your password again.");
  }
  async consumeChallenge(id: unknown, purpose: string, prehash: string) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      deny(401, "Invalid or expired scan.");
    const r = await this.pool.query(
      `DELETE FROM auth_tokens WHERE hash=$1 AND kind='challenge' AND expires>now() AND data->>'purpose'=$2 AND data->>'preauth'=$3 RETURNING *`,
      [hashSecret(id as string), purpose, prehash],
    );
    return (
      r.rows[0] ??
      deny(401, "This scan expired or was already used. Start a new scan.")
    );
  }
  async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(7101701)");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async audit(
    db: pg.Pool | pg.PoolClient,
    actor: string | null,
    action: string,
    target: string | null,
  ) {
    await db.query(
      "INSERT INTO auth_audit(actor,action,target) VALUES($1,$2,$3)",
      [actor, action, target],
    );
  }
  async handle(
    action: string,
    body: any,
    credentials: Credentials,
    address: string,
  ): Promise<Result> {
    try {
      return await this.run(action, body ?? {}, credentials, address);
    } catch (error) {
      if (error instanceof AuthError)
        return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }
  private async run(
    action: string,
    body: any,
    credentials: Credentials,
    address: string,
  ): Promise<Result> {
    if (action === "logout") {
      await this.transaction(async (db) => {
        const hashes = [credentials.session, credentials.preauth]
          .filter(Boolean)
          .map((raw) => tokenHash(raw));
        await db.query(
          "DELETE FROM auth_tokens WHERE hash=ANY($1::text[]) OR (kind='session' AND data->>'preauth'=$2)",
          [hashes, tokenHash(credentials.preauth)],
        );
      });
      return { status: 200, body: { unlocked: false }, clear: true };
    }
    if (action === "session") {
      const session = await this.getSession(credentials.session);
      return {
        status: 200,
        body: {
          unlocked: session?.role === "user",
          role: session?.role ?? null,
          name: session?.name ?? null,
        },
      };
    }
    if (action === "password") {
      await this.throttle(address, "password", 5);
      if (
        typeof body.password !== "string" ||
        Buffer.byteLength(body.password) > 512
      )
        deny(400, "Enter a valid password.");
      const user = verifyPasswordHash(body.password, this.config.userHash),
        admin = verifyPasswordHash(body.password, this.config.adminHash);
      if (user === admin) deny(401, "Access denied.");
      const role = admin ? "admin" : "user";
      const exists = await this.pool.query(
        "SELECT 1 FROM auth_users WHERE role='admin'",
      );
      if (credentials.preauth)
        await this.pool.query("DELETE FROM auth_tokens WHERE hash=$1", [
          tokenHash(credentials.preauth),
        ]);
      return {
        status: 200,
        body: { role, setupRequired: admin && !exists.rowCount },
        preauth: await this.createToken("preauth", role, null, {}, 300_000),
      };
    }
    if (action === "status") {
      await this.throttle(address, "status", 60, 60_000);
      const r = await this.pool.query(
        `SELECT u.status,u.name FROM auth_tokens t JOIN auth_users u ON t.user_id=u.id WHERE t.hash=$1 AND t.kind='receipt' AND t.expires>now()`,
        [tokenHash(body.receipt)],
      );
      if (!r.rowCount) deny(404, "Enrollment request not found or expired.");
      return { status: 200, body: r.rows[0] };
    }
    if (action.startsWith("admin-"))
      return this.admin(action, body, credentials.session, address);
    const pre = await this.preauth(credentials.preauth);
    await this.throttle(address, "capture", 20);
    if (action === "challenge") {
      const purpose = body.purpose;
      if (!["login", "enroll", "setup", "recover"].includes(purpose))
        deny(400, "Invalid scan purpose.");
      if (purpose === "enroll" && pre.role !== "user")
        deny(403, "Use the normal password to request enrollment.");
      if (["setup", "recover"].includes(purpose) && pre.role !== "admin")
        deny(403, "Administrator authentication required.");
      if (purpose === "setup") {
        const exists = await this.pool.query(
          "SELECT 1 FROM auth_users WHERE role='admin'",
        );
        if (exists.rowCount)
          deny(409, "Administrator setup is already complete.");
        if (
          typeof body.setupToken !== "string" ||
          body.setupToken.length > 256 ||
          hashSecret(body.setupToken) !== this.config.setupHash
        )
          deny(403, "Invalid setup secret.");
      }
      let recoverUser: string | null = null;
      let recoverVersion: number | null = null;
      if (purpose === "recover") {
        await this.throttle(address, "recovery", 5);
        if (
          typeof body.recoveryCode !== "string" ||
          body.recoveryCode.length > 256
        )
          deny(403, "Invalid recovery code.");
        const r = await this.pool.query(
          "DELETE FROM auth_tokens t USING auth_users u WHERE t.hash=$1 AND t.kind='recovery' AND t.expires>now() AND t.user_id=u.id RETURNING t.user_id,u.auth_version",
          [hashSecret(body.recoveryCode)],
        );
        if (!r.rowCount) deny(403, "Invalid recovery code.");
        recoverUser = r.rows[0].user_id;
        recoverVersion = r.rows[0].auth_version;
      }
      const instruction = randomInt(2) === 0 ? "left-right" : "right-left";
      const id = await this.createToken(
        "challenge",
        pre.role,
        recoverUser,
        { purpose, preauth: pre.hash, instruction, recoverVersion },
        90_000,
      );
      await this.pool.query(
        "UPDATE auth_tokens SET data=data||jsonb_build_object('id',$2::text) WHERE hash=$1",
        [hashSecret(id), id],
      );
      return {
        status: 200,
        body: { challengeId: id, instruction, expiresIn: 90 },
      };
    }
    if (!["login", "enroll", "setup", "recover"].includes(action))
      deny(400, "Unknown authentication action.");
    if (
      action === "enroll" &&
      (body.consent !== true ||
        typeof body.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.trim().length > 80)
    )
      deny(400, "Enter your name and consent to face-template storage.");
    const scan = await this.consumeChallenge(
      body.challengeId,
      action,
      pre.hash,
    );
    let descriptor: number[];
    try {
      descriptor = await this.verify(body.images, scan.data.instruction);
      faceDistance(descriptor, descriptor);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown face verification error";
      // Only classify the failure in server logs; never log frames or templates.
      console.error("[auth] Face verification rejected:", reason);
      const safeErrors = [
        "Start with your face looking straight at the camera.",
        "First head turn was too small. Turn a little farther toward the first arrow.",
        "Second head turn was too small. Turn a little farther toward the second arrow.",
        "Both turns looked like the same direction. Turn toward opposite sides of the camera.",
        "Show exactly one well-lit face, closer to the camera.",
        "No face was detected in one of the scan frames. Keep your whole face visible while turning.",
        "More than one face was detected. Please scan alone.",
        "Your face appeared too small in one frame. Move a little closer to the camera.",
        "Keep the same face in view throughout the scan.",
        "Not enough clear photos were detected. Keep your face in view and try again.",
        "Photos were not consistent enough to confirm one face. Try again with steadier lighting.",
      ];
      deny(400, safeErrors.includes(reason)
        ? reason
        : "The face scan could not be processed. Try again; if it continues, contact the administrator.");
    }
    return this.transaction(async (db) => {
      // Recheck pre-auth and administrator setup after inference and locking.
      const fresh = await db.query(
        "SELECT 1 FROM auth_tokens WHERE hash=$1 AND kind='preauth' AND expires>now()",
        [pre.hash],
      );
      if (!fresh.rowCount) deny(401, "Enter your password again.");
      await db.query(
        "UPDATE auth_users SET status='rejected',template=NULL,updated=now() WHERE status='pending' AND created<now()-interval '7 days'",
      );
      const all = await db.query(
        "SELECT * FROM auth_users WHERE template IS NOT NULL AND status IN ('pending','approved')",
      );
      const matches = all.rows.filter(
        (u) =>
          faceDistance(
            descriptor,
            unseal(u.template, this.config.templateKey, u.id),
          ) <= FACE_THRESHOLD,
      );
      if (action === "login") {
        const allowed = matches.filter(
          (u) => u.role === pre.role && u.status === "approved",
        );
        if (allowed.length !== 1)
          deny(
            401,
            "No approved face matched. New users can request enrollment.",
          );
        const user = allowed[0];
        const session = await this.createToken(
          "session",
          user.role,
          user.id,
          { preauth: pre.hash },
          user.role === "admin" ? 1_800_000 : 43_200_000,
          db,
        );
        await db.query("DELETE FROM auth_tokens WHERE hash=$1", [pre.hash]);
        await this.audit(db, user.id, "login", user.id);
        return {
          status: 200,
          body: { unlocked: user.role === "user", role: user.role },
          session,
        };
      }
      if (action === "enroll") {
        if (pre.role !== "user") deny(403, "User enrollment required.");
        if (matches.some((u) => u.role === "user"))
          deny(
            409,
            "This face already has an enrollment. Contact the administrator.",
          );
        const id = randomUUID();
        // Store a single encrypted thumbnail only while awaiting approval.
        // The 20 captured images are otherwise discarded after verification.
        const preview = body.images?.[0];
        if (typeof preview !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview) || preview.length > 120_000)
          deny(400, "A valid enrollment photo is required.");
        await db.query(
          "INSERT INTO auth_users(id,name,role,status,template,review_photo) VALUES($1,$2,'user','pending',$3,$4)",
          [id, body.name.trim(), seal(descriptor, this.config.templateKey, id), seal(preview, this.config.templateKey, id)],
        );
        const receipt = await this.createToken(
          "receipt",
          "user",
          id,
          {},
          604_800_000,
          db,
        );
        await this.audit(db, null, "enroll", id);
        return { status: 202, body: { status: "pending", receipt } };
      }
      if (pre.role !== "admin")
        deny(403, "Administrator authentication required.");
      // Administrator and user enrollment are separate, even for the same face.
      const existing = await db.query(
        "SELECT * FROM auth_users WHERE role='admin'",
      );
      let id = scan.user_id;
      if (action === "setup") {
        if (existing.rowCount)
          deny(409, "Administrator setup is already complete.");
        id = randomUUID();
        await db.query(
          "INSERT INTO auth_users(id,name,role,status,template) VALUES($1,'Administrator','admin','approved',$2)",
          [id, seal(descriptor, this.config.templateKey, id)],
        );
      } else {
        if (!existing.rowCount || existing.rows[0].id !== id)
          deny(403, "Invalid recovery request.");
        if (existing.rows[0].auth_version !== scan.data.recoverVersion)
          deny(
            401,
            "This recovery scan was invalidated. Start a new recovery.",
          );
        await db.query(
          "UPDATE auth_users SET template=$2,auth_version=auth_version+1,updated=now() WHERE id=$1",
          [id, seal(descriptor, this.config.templateKey, id)],
        );
        await db.query("DELETE FROM auth_tokens WHERE user_id=$1", [id]);
      }
      const recoveryCodes = [];
      for (let i = 0; i < 8; i++) {
        const code = newToken();
        recoveryCodes.push(code);
        await db.query(
          "INSERT INTO auth_tokens(hash,kind,role,user_id,expires) VALUES($1,'recovery','admin',$2,now()+interval '10 years')",
          [hashSecret(code), id],
        );
      }
      const session = await this.createToken(
        "session",
        "admin",
        id,
        { preauth: pre.hash },
        1_800_000,
        db,
      );
      await db.query("DELETE FROM auth_tokens WHERE hash=$1", [pre.hash]);
      await this.audit(db, id, action, id);
      return { status: 200, body: { role: "admin", recoveryCodes }, session };
    });
  }
  private async admin(
    action: string,
    body: any,
    raw: string | undefined,
    address: string,
  ): Promise<Result> {
    const session =
      (await this.getSession(raw, "admin")) ??
      deny(403, "Administrator authentication required.");
    await this.throttle(address, "admin", 120, 60_000);
    if (action === "admin-list") {
      await this.cleanup();
      const r = await this.pool.query(
        "SELECT id,name,role,status,created,updated,review_photo FROM auth_users WHERE role='user' ORDER BY created DESC LIMIT 500",
      );
      return { status: 200, body: { users: r.rows.map(({ review_photo, ...user }) => ({
        ...user,
        preview: user.status === "pending" && review_photo
          ? unseal(review_photo, this.config.templateKey, user.id) as unknown as string
          : null,
      })) } };
    }
    if (
      ![
        "admin-approve",
        "admin-reject",
        "admin-revoke",
        "admin-delete",
      ].includes(action) ||
      typeof body.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.id)
    )
      deny(400, "Invalid administrator action.");
    return this.transaction(async (db) => {
      const current = await db.query(
        "SELECT 1 FROM auth_tokens WHERE hash=$1 AND kind='session' AND expires>now()",
        [session.id],
      );
      if (!current.rowCount) deny(403, "Administrator session expired.");
      const r = await db.query(
        "SELECT * FROM auth_users WHERE id=$1 AND role='user' FOR UPDATE",
        [body.id],
      );
      if (!r.rowCount) deny(404, "User not found.");
      if (action === "admin-approve") {
        if (
          r.rows[0].status !== "pending" ||
          !r.rows[0].template ||
          new Date(r.rows[0].created).getTime() < Date.now() - 604_800_000
        )
          deny(409, "Only current pending requests can be approved.");
        await db.query(
          "UPDATE auth_users SET status='approved',review_photo=NULL,updated=now() WHERE id=$1",
          [body.id],
        );
      } else if (action === "admin-delete")
        await db.query("DELETE FROM auth_users WHERE id=$1", [body.id]);
      else {
        await db.query(
          "UPDATE auth_users SET status=$2,template=NULL,review_photo=NULL,updated=now() WHERE id=$1",
          [body.id, action === "admin-reject" ? "rejected" : "revoked"],
        );
        await db.query(
          "DELETE FROM auth_tokens WHERE user_id=$1 AND kind='session'",
          [body.id],
        );
      }
      await this.audit(db, session.userId, action, body.id);
      return { status: 200, body: { ok: true } };
    });
  }
}

let defaultService: AuthService | undefined;
export function getAuthService() {
  if (!defaultService) {
    const config = readAuthConfig();
    defaultService = new AuthService(
      new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        query_timeout: 5000,
        statement_timeout: 5000,
      }),
      config,
    );
  }
  return defaultService;
}
