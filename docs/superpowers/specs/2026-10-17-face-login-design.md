# Password and face login with admin approval

## Requested behavior

Keep one login form. A normal password starts the user flow; a different admin
password starts the admin flow. Passwords alone never unlock either area.

- Normal password plus an approved face opens Scramjet.
- A new user enters the normal password, chooses Enrol your face, supplies a
  display name, consents to storage, and captures their face. The application
  records a pending request and does not issue an access session.
- The administrator approves or rejects pending requests in the Admin Panel.
- Admin password plus the administrator's enrolled face opens the Admin Panel.
- Revoking a user invalidates their sessions and prevents new logins.
- No external face-recognition API, external account, or separate installed app
  is involved. Open-source recognition code and model files are hosted by this
  application. Camera access requires browser permission and HTTPS or localhost.

## Current repository and scope

The application currently has a source-controlled shared password, stateless
signed access cookies, Vercel functions, a local development server, and a
separate persistent Wisp backend. There is no user database. Camera access is
explicitly disabled in both the shared headers and vercel.json.

This change adds an authentication subsystem. It must replace the password-only
paths in both local and deployed environments, not just add a camera screen.
Existing access cookies must stop working at migration. The proxy's navigation
and rewriting behavior is outside scope.

## Storage and configuration

Use PostgreSQL for durable records and transactional changes. It may be
self-hosted; no third-party identity or biometric service is required. Do not use
localStorage, a serverless temporary directory, or process memory as the identity
database. Run a local PostgreSQL instance for development and integration tests.

Required deployment configuration:

- DATABASE_URL: PostgreSQL connection credentials, supplied securely.
- ACCESS_PASSWORD_HASH and ADMIN_PASSWORD_HASH: independently salted scrypt
  password hashes. Require different passwords; remove the committed password.
- SESSION_SECRET: existing server-side session-signing secret.
- FACE_TEMPLATE_KEY: independent encryption key for face templates.
- ADMIN_SETUP_TOKEN_HASH: hash of a high-entropy, single-use setup secret.
- AUTH_ORIGIN: exact permitted HTTPS application origin; localhost in development.

Provide a local CLI that creates hashes and setup/recovery material without
placing plaintext credentials in source control, command arguments, or logs.
Document secure deployment entry and database migrations. Missing configuration
fails closed with an actionable setup message; no password-only fallback.

## Records

- Users: random ID, display name, immutable role (user/admin), status
  (pending/approved/rejected/revoked), encrypted face templates, timestamps.
- Challenges: random ID and nonce, purpose, bound pre-auth session, randomized
  capture instructions, expiration, consumed timestamp, attempt budget.
- Sessions: hashed random token, user ID, purpose/role, expiration, revocation.
- Setup state: singleton admin bootstrap completion, recorded transactionally.
- Recovery codes: individually hashed, single-use codes bound to the admin.
- Audit events: actor ID, action, target ID, time; no pictures, templates,
  passwords, cookies, or recovery secrets in logs.

Use authenticated encryption for templates with a per-record nonce and user ID
as associated data. Do not persist raw camera images or capture video. Rejected
requests delete biometric templates immediately; retain only non-biometric
decision metadata. Revocation deletes templates and sessions. Pending requests
expire and delete templates after seven days.

## Secure administrator bootstrap and recovery

The deployment owner uses the setup secret plus admin password to obtain a
short-lived bootstrap challenge and enroll the initial admin face. A database
transaction permits exactly one administrator and consumes the setup state.
Knowing the regular password cannot authorize this operation. Once complete,
the setup route remains disabled even if the environment variable is still set.

The administrator receives recovery codes once, with a download/save prompt.
Admin password plus a valid unused recovery code authorizes replacement of a
lost face enrollment, not unrestricted password-only access. Replacement revokes
existing admin sessions. Requests to reset without these factors fail closed.

## Password, capture, and approval flow

1. POST the password to the server. Verify against the two configured hashes
   with equal work and generic failure messages. A success issues a short-lived,
   HttpOnly, SameSite=Strict pre-auth cookie bound to the appropriate role. It is
   not a Scramjet or admin session.
2. For login, issue a one-use capture challenge. Capture fresh camera frames and
   send them to the server; never accept a browser-provided descriptor or a
   client-side match result as proof of identity.
3. The server computes the descriptor using a self-hosted face recognition
   model, rejects missing/multiple faces and low-quality captures, and checks the
   randomized movement/blink challenge. Match only approved users in the
   pre-auth role. The normal flow can never match the admin as a normal user.
4. A successful match consumes the challenge atomically and issues a new
   database-backed session. A failed, expired, repeated, or wrong-purpose
   challenge never issues a session.
5. Enrollment is a separate explicit action after the normal password. It uses
   its own challenge, records the name and encrypted templates, and returns
   pending status. Keep a random enrollment receipt for checking this request's
   status without exposing an enumerable public user list.
6. The Admin Panel lists names, pending/active status, dates, and request IDs.
   Approve, reject, revoke, and delete actions require a current admin session
   and server-side authorization. Names are unverified labels, not proof of
   real-world identity; the admin should confirm requests with the requester.
   Regular enrollment can never create or modify an administrator.

No automatic approval, no session issuance on approval alone, and no camera
recording after capture, navigation, cancellation, or an error. Pending users
must perform a fresh login after approval. Reject duplicate enrollments matching
an existing identity; do not reveal the existing person's name to the requester.

## Sessions and proxy authorization

Use a new cookie version to invalidate all existing password-only sessions.
Regular and admin sessions have separate scopes; an admin session does not
implicitly unlock Scramjet. Every protected API checks current user approval and
session state in PostgreSQL, including /api/access and /api/wisp-config. Local
Wisp upgrades must check the same state before accepting connections.

Update the production Wisp token to carry the session identity and a 60-second
expiry and validate it server-side. Track active connections by session and
disconnect revoked sessions within 60 seconds using periodic authorization
checks. Reject the previous unbound timestamp-only Wisp tokens after migration.
Define a rollout order so old and new auth components cannot silently mix.

## Request protection and browser integration

Validate Origin against AUTH_ORIGIN on state-changing requests. Use narrowly
scoped server-side authorization, schema validation, body/image limits, short
timeouts, and database-backed attempt limits across serverless instances. Rate
limit password attempts, capture verification, and enrollment creation. Never
return a face descriptor or a template through the Admin Panel API.

Only the top-level application's camera is enabled through camera=(self).
Keep microphone and other existing restricted permissions disabled. Never grant
camera permission to proxied iframes. The login and Admin Panel remain outside
the proxied frame. API and camera responses use Cache-Control: no-store. Clear
pre-auth and camera state on logout. The double-tilde shortcut remains available.

## Face-matching limits and implementation feasibility

Use an existing face embedding model, self-host its versioned/checksummed model
files, and perform recognition server-side. Do not substitute landmark distance,
image hashes, a single average pixel score, or mocked matches for recognition.
Choose the matching threshold against documented model guidance, then verify
with consented human captures before claiming real recognition accuracy.

Before building dependent UI, benchmark model startup and inference on the
actual Node 22 deployment target, including Vercel bundle size, memory, CPU,
execution timeout, and image-body limits. If the selected model cannot run
within those limits, host the recognition worker in the application's existing
persistent Node backend and keep images off logs and persistent storage. This
remains first-party application infrastructure; the serverless functions call
it over authenticated HTTPS. Report any required hosting configuration.

Randomized blink/head-turn prompts detect simple still-photo attempts but do
not prove liveness against replay, virtual cameras, deepfakes, or a malicious
client. Do not label this Apple Face ID, certified biometric authentication, or
spoof-proof login. The UI and deployment documentation must disclose that limit.
Production spoof resistance and a usable matching threshold require real-camera
testing; synthetic fixtures alone cannot establish them.

## Validation and acceptance

- Integration tests use real PostgreSQL and exercise the deployed API handlers
  as well as local development routes.
- Prove that passwords alone, pending/rejected/revoked users, a forged browser
  match, and previous-version cookies cannot obtain access or Wisp credentials.
- Test admin-role enforcement, origin checks, database attempt limits, challenge
  expiry/replay, simultaneous bootstrap, and cross-purpose credential reuse.
- Test approval, rejection, template deletion, session invalidation, Wisp
  disconnection, and persistence after restart.
- Test camera denied/unavailable, cancellation, no/multiple faces, expiration,
  and camera stream shutdown with browser automation.
- Run real model inference on authorized test captures. Separately report
  mocked camera tests and human recognition/liveness checks; do not conflate
  them. Never commit real faces, passwords, or enrolled templates as fixtures.
- Run the existing test suite and frontend build, and verify that the existing
  quick exit and normal proxy navigation still work after authenticated login.

The feature is not production-ready until the database, secrets, initial admin
enrollment, hosting limits, and human-camera checks are verified. Document exact
outstanding steps rather than silently weakening authentication to finish.
