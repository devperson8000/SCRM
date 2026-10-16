# Face Login Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Track checks below.

**Goal:** Enforce password plus an approved face for users, password plus admin face for administrators, and administrator approval of enrollment.

**Architecture:** Shared first-party Node authentication service with PostgreSQL, encrypted embeddings, single-use capture challenges, role-scoped sessions and revocation. Browser camera UI calls the same handlers in development and Vercel. Recognition runs server-side; serverless deployment constraints must be checked.

**Tech Stack:** Node 22, TypeScript, PostgreSQL/pg, self-hosted face-api model with TensorFlow CPU, browser MediaDevices.

**Spec:** docs/superpowers/specs/2026-10-17-face-login-design.md

## Global Constraints

- Password-only authentication and old cookies must not grant access.
- Pending/rejected/revoked users cannot enter Scramjet.
- Admin bootstrap is one-time and requires a separately configured secret.
- No face templates or match decisions supplied by clients are trusted.
- Model files are versioned and integrity checked; camera streams stop after capture.
- Production configuration and human-camera checks are prerequisites, not assumed successes.

## Review Focus

- Concurrent admin setup/challenge replay must produce exactly one success.
- Camera denial, navigation, cancel and failed API requests must release camera tracks.
- Revocation must close already connected proxy sockets within 60 seconds.
- Non-admin and forged role requests must never reach approval actions.
- Malformed/oversized images and model failure must fail closed without leaking templates.

### Task 1: Runtime and recognition
**Files:** api/_lib/face.ts, scripts/auth-models.ts, tests/face.test.ts, package.json, pnpm-lock.yaml.
**Interfaces:** verifyCapture(images: string[], instruction: string): Promise<number[]> returns only server-computed embeddings; faceDistance(a,b) and image limits reject invalid inputs.
- [ ] Write failing image validation/model tests and verify failure.
- [ ] Install pinned recognition and database dependencies. Benchmark Node 22 model load/inference with real tensors; use first-party persistent worker if needed.
- [ ] Implement model integrity verification, JPEG decoding, one-face quality checks, embedding consistency and randomized movement checks.
- [ ] Run tests and record model behavior/limitations.

### Task 2: Database-backed authorization
**Files:** api/_lib/auth-{crypto,db,service,http}.ts, scripts/auth-config.ts, scripts/auth-migrate.ts, tests/auth.test.ts.
**Interfaces:** AuthService.handle(action, body, credentials, address) returns status/body/cookies. getSession(token, role) consults PostgreSQL. authorizeWisp(token) validates identity and current approval.
- [ ] Write failing PostgreSQL integration tests for password preauth, bootstrap concurrency, role separation, pending denial, approvals, session revocation, origin checks, replay/expiry, and recovery.
- [ ] Implement schema migration, salted password verification, encrypted templates, durable throttles/challenges/sessions, one-time bootstrap and recovery, administrative actions and audit events.
- [ ] Verify tests with real PostgreSQL and injected capture verifier (authorization tests do not claim biometric accuracy).

### Task 3: Application and transport integration
**Files:** api/access.ts, api/admin.ts, api/wisp-config.ts, devserver.ts, wisp-server.ts, api/_lib/session.ts, vercel.json.
**Interfaces:** /api/access action-based login/enrollment/setup/recovery; /api/admin list/approve/reject/revoke/delete; signed Wisp tokens bound to session and expiring in 60 seconds.
- [ ] Write failing HTTP tests for origins, password-only access, old cookies, admin role checks and unbound Wisp tokens.
- [ ] Replace local/deployed password routes with shared handlers. Update Wisp authorization and periodic revocation checks.
- [ ] Enable only self-origin top-level camera; keep proxy-frame camera blocked. Remove committed password and old cookie issuance.
- [ ] Run integration tests and type checks for changed server code.

### Task 4: Camera UI and Admin Panel
**Files:** auth/login.ts, auth/camera.ts, auth/admin.ts, auth/auth.css, index.tsx.
**Interfaces:** showLogin(root): Promise<'user'> mounts login or Admin Panel without proxy startup for administrators; camera capture returns frames and always stops tracks.
- [ ] Write browser checks for enrollment-pending screen, camera denial/cancel cleanup, name validation, admin-only buttons, failed requests and quick exit.
- [ ] Implement password form, verify/enroll, explicit biometric consent, status receipt, one-time admin setup/recovery and approval dashboard.
- [ ] Verify with Chromium mocked camera; separately disclose need for real-person accuracy/spoof testing.

### Task 5: Deployment, verification and review
**Files:** FACE_AUTH_SETUP.md, compose.auth.yaml, deployment configuration and tests.
- [ ] Document database migration, password/key/setup CLI, production origin, model packaging/worker, cold-start limits, session migration and rollout order.
- [ ] Run all existing/new tests, frontend build and browser smoke checks. Record outstanding external configuration and human-camera checks.
- [ ] Dispatch one fresh reviewer for the complete change, fix critical/important findings with failing regression tests, rerun affected checks.
- [ ] Commit coherent changes; do not publish or push without user instruction.
