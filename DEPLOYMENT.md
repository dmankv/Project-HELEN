# Daemon – System Architecture & Deployment

## Overview

Daemon is a React/TypeScript chat interface deployed as a **static site on GitHub Pages**.
The frontend includes a built-in rule/template-based response engine that works with no backend.
An optional Node.js API proxy (`server/`) can be separately hosted to route requests to an LLM
provider (OpenAI or Anthropic) without exposing API keys in the browser.

---

## Frontend entrypoint chain

```
index.html
  └─ src/main.tsx          (React root mount)
       └─ src/App.tsx       (top-level component shell)
            └─ src/components/DaemonInterface.tsx   (chat UI)
                 └─ src/services/daemonResponseBrain.ts  (local rule engine)
                 └─ src/services/daemonChatAPI.ts        (optional cloud API)
```

### Local mode (default)
`daemonResponseBrain.ts` produces responses entirely in the browser – no network call is made.

### Cloud API mode (optional)
When the environment variable `VITE_DAEMON_API_URL` is set at build time, `daemonChatAPI.ts` sends
requests to that URL. The server at that URL must be the separately hosted `server/` gateway.

---

## Frontend components

| File | Purpose |
|------|---------|
| `src/main.tsx` | React root (`ReactDOM.createRoot`) |
| `src/App.tsx` | App shell |
| `src/components/DaemonInterface.tsx` | Chat UI, message list, input, sync status |
| `src/services/daemonResponseBrain.ts` | Rule/template-based local response engine |
| `src/services/daemonChatAPI.ts` | HTTP client for optional self-hosted cloud API |
| `src/services/supabaseEdgeChat.ts` | Client for Supabase Edge Function (authenticated AI) |
| `src/services/supabasePersistence.ts` | Authenticated Supabase persistence (conversations, memories, learning) |
| `src/services/daemonMemory.ts` | In-browser durable memory (localStorage fallback) |
| `src/services/supabaseAuthAPI.ts` | Supabase managed auth (login, register, session) |

---

## Supabase integration (recommended for GitHub Pages)

### What is persisted in Supabase

When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set and the user is authenticated:

| Table | Content |
|-------|---------|
| `conversations` | User-owned conversation metadata (title, timestamps) |
| `messages` | Individual messages (role, content, position) |
| `durable_memories` | User's "remember this" memories |
| `learning_interactions` | Chat turns with metadata and feedback |
| `edge_rate_limits` | Per-user rate limit counters (service_role only) |

All tables use `auth.uid()` Row Level Security — each user can only access their own data.

### RLS ownership model

- Every user-data table has a `user_id` column referencing `auth.users(id)`
- All CRUD policies use `auth.uid() = user_id`
- Security-definer triggers block `user_id` reassignment at the database level
- No public (unauthenticated) policies exist on any user-data table
- `edge_rate_limits` is accessible only via service_role (used by the Edge Function)

### One-time Supabase setup

#### 1. Apply the database migrations

In Supabase Dashboard → SQL Editor, run in order:

```sql
-- Migration 1: RBAC / profiles
-- supabase/migrations/20260824143000_managed_auth_rbac.sql

-- Migration 2: Daemon persistence tables
-- supabase/migrations/20260824160000_daemon_persistence.sql
```

#### 2. Configure GitHub Actions variables (public, browser-safe)

In GitHub → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://your-project-ref.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon/public key |

These are injected at build time by `deploy.yml` and are safe to embed in the browser.

#### 3. Deploy the Supabase Edge Function (for authenticated AI)

```bash
supabase functions deploy daemon-chat
```

> **Deployment boundary:** the GitHub Pages workflow deploys only the static frontend.
> It does **not** deploy `supabase/functions/daemon-chat`, create Supabase secrets,
> or repair a missing Edge Function deployment.

#### 4. Set Edge Function secrets (server-only — NEVER commit values)

```bash
supabase secrets set OPENAI_API_KEY=sk-...
# or for Anthropic:
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set DAEMON_PROVIDER=anthropic
supabase secrets set DAEMON_MODEL=claude-3-5-haiku-20241022  # optional
```

These secrets are held only in Supabase and are never present in the browser bundle.

### Cloud chat diagnostics

The fallback message “I used local mode for this response” does **not** prove a live outage by
itself. Without direct access to the project logs/secrets, you can only confirm the code-level
failure taxonomy below and then inspect the Supabase project directly.

#### Verified client-visible categories

| Category | Meaning | Safe user message |
|---|---|---|
| `not-configured` | `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` missing from the frontend build | “Cloud chat is not configured in this build. I used local mode for this response.” |
| `not-signed-in` | No current signed-in Supabase session | “Cloud chat is available after you sign in. I used local mode for this response.” |
| `auth` | Function returned `401`/`403` | “Cloud chat rejected the current session. I used local mode for this response.” |
| `rate-limited` | Function returned `429` | “Cloud chat is temporarily rate-limited. I used local mode for this response.” |
| `not-found` | Function returned `404` | “Cloud chat is not deployed or this build points at the wrong project. I used local mode for this response.” |
| `provider` | Function returned `502`/`503` or safe provider/config error code | “Cloud chat is temporarily unavailable. I used local mode for this response.” |
| `server` | Other server-side error | “Cloud chat had a temporary server error. I used local mode for this response.” |
| `timeout` | Browser-side request timeout | “Cloud chat timed out. I used local mode for this response.” |
| `network` | Browser could not reach the function | “Cloud chat could not be reached from this browser. I used local mode for this response.” |
| `aborted` | User cancelled the request | No fallback/error banner is shown. |

#### Safe Edge Function error codes

The Supabase Edge Function returns only safe machine-readable codes:

- `AUTH_REQUIRED`
- `INVALID_TOKEN`
- `RATE_LIMITED`
- `FUNCTION_CONFIG_ERROR`
- `PROVIDER_UNAVAILABLE`
- `BAD_REQUEST`
- `ORIGIN_NOT_ALLOWED`
- `METHOD_NOT_ALLOWED`
- `INTERNAL_ERROR`

These codes are intentionally generic. They do **not** include provider response bodies, SQL
errors, stack traces, prompt contents, tokens, or secret values.

#### Operator steps: check deployment, logs, and configuration

1. Open **Supabase Dashboard → Edge Functions → `daemon-chat`**.
2. Confirm the function exists and the latest deployment succeeded. If it does not exist, deploy it:
   ```bash
   supabase functions deploy daemon-chat
   ```
3. Open the function’s **Logs** tab and look for safe codes such as
   `RATE_LIMITED`, `INVALID_TOKEN`, `PROVIDER_UNAVAILABLE`, or `FUNCTION_CONFIG_ERROR`.
4. Open **Supabase Dashboard → Project Settings → Edge Functions / Secrets** (or use the CLI)
   and verify that the function has:
   - `OPENAI_API_KEY` **or** `ANTHROPIC_API_KEY`
   - `DAEMON_PROVIDER`
   - optional `DAEMON_MODEL`
   - Supabase runtime variables injected by the platform (`SUPABASE_URL`,
     `SUPABASE_SERVICE_ROLE_KEY`, and the project’s function anon key/runtime auth context)
5. Verify the frontend build variables in **GitHub → Settings → Secrets and variables → Actions → Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Reproduce the request in the browser and inspect the request to
   `/functions/v1/daemon-chat`:
   - `404` usually means the function is missing or the build points at the wrong Supabase project
   - `401`/`403` means the browser session/JWT was rejected
   - `429` means the per-user function rate limit was hit
   - `502`/`503` means the function reported safe provider/config unavailability
   - browser timeout/network failure means the request did not complete successfully from the client

### Edge Function security boundaries

| Concern | Mechanism |
|---------|-----------|
| Auth | Supabase JWT verification (every non-preflight request) |
| Rate limit | Per-user count in `public.edge_rate_limits` via service_role |
| Schema | Message array, role validation, size/count limits |
| Secrets | Provider keys in Supabase Function secrets only |
| CORS | Only `https://dmankv.github.io` and localhost (dev) |
| Error masking | Provider errors are logged server-side; generic message to client |

---

## Optional backend (`server/`)

`server/index.ts` is a Node.js HTTP gateway (no Express).
It proxies `POST /api/chat` to OpenAI/Anthropic and also serves authentication endpoints.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAEMON_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | When provider=openai | – | OpenAI secret key |
| `ANTHROPIC_API_KEY` | When provider=anthropic | – | Anthropic secret key |
| `DAEMON_MODEL` | No | provider default | Override model name |
| `DAEMON_ALLOWED_ORIGINS` | No | `http://localhost:3000,http://localhost:4173` | Comma-separated allowed CORS origins |
| `DAEMON_FRONTEND_URL` | No | `http://localhost:3000/Project-HELEN/` | Base URL used in verification/reset email links |
| `DAEMON_API_TOKEN` | No | – | Optional token for non-browser `/api/chat` clients; never expose it through Vite |
| `PORT` | No | `3001` | Listening port |
| `AUTH_DATA_FILE` | No | `.data/auth-store.json` | Persistent auth user/session/token store |
| `AUTH_DEV_EMAIL_OUTBOX_FILE` | No | `.data/auth-email-outbox.jsonl` | Development/test email outbox adapter |
| `AUTH_REQUIRE_HTTPS` | No | `true` in prod | Reject sensitive auth requests over non-HTTPS |
| `AUTH_SECURE_COOKIES` | No | `true` in prod | Enables `Secure` cookies |
| `AUTH_SESSION_TTL_MS` | No | `43200000` | Session lifetime |
| `AUTH_VERIFY_TTL_MS` | No | `86400000` | Verification token lifetime |
| `AUTH_RESET_TTL_MS` | No | `1800000` | Reset token lifetime |
| `AUTH_RATE_LIMIT_MAX` | No | `20` | Auth rate-limit requests per IP per endpoint |
| `AUTH_RATE_LIMIT_WINDOW_MS` | No | `60000` | Auth rate-limit window |
| `DAEMON_RATE_LIMIT` | No | `60` | Max requests per IP per minute |
| `DAEMON_RATE_LIMIT_WINDOW_MS` | No | `60000` | Chat rate-limit window |
| `DAEMON_TRUST_PROXY` | No | _(unset)_ | Set to `1` when deployed behind a reverse proxy (Vercel, Fly.io, nginx, etc.) so the rate limiter reads the real client IP from `X-Forwarded-For` instead of the proxy's socket address. **Leave unset when the server faces the internet directly** to prevent IP-spoofing. |

Frontend variable (set at Vite build time):

| Variable | Description |
|----------|-------------|
| `VITE_DAEMON_API_URL` | Full URL to server (e.g. `https://your-server.example.com`). Omit to use local mode. |
| `VITE_DAEMON_AUTH_API_URL` | Optional explicit auth API URL; defaults to `VITE_DAEMON_API_URL`. |

> **CSP note:** When `VITE_DAEMON_API_URL` is set, `vite.config.ts` automatically adds that
> server's origin to the `connect-src` directive of the built HTML's Content-Security-Policy,
> allowing the browser to reach the backend.  If you patch or replace `dist/index.html` after
> the build, ensure `connect-src` includes your server's origin — otherwise every API call
> will be blocked by the browser with a CSP violation.

### HELEN → Daemon migration compatibility

New deployments should use the `DAEMON_*` and `VITE_DAEMON_*` names above. During the
transition, the server accepts legacy `HELEN_*` configuration variables and the legacy
`X-HELEN-API-TOKEN` header when their Daemon equivalents are absent. The frontend and CSP
plugin likewise fall back to `VITE_HELEN_API_URL` and `VITE_HELEN_AUTH_API_URL`, so an
existing build configuration keeps connecting while it is updated.

Browser state is migrated once from `helen_messages`, `helen_conversations`,
`helen_sidebar_open`, `helen_durable_memories`, and `helen_learning_data` to their
`daemon_*` equivalents. Existing default `helen_session` and `helen_csrf` cookies are
accepted once and reissued as `daemon_session` and `daemon_csrf`; custom
`AUTH_COOKIE_NAME` and `AUTH_CSRF_COOKIE_NAME` values remain unchanged.

`AUTH_DATA_FILE` and `AUTH_DEV_EMAIL_OUTBOX_FILE` are identity-neutral settings. Keep
their existing values during the upgrade so user records, sessions, and development email
outbox data remain available. The `/var/lib/daemon/` paths in `.env.example` are examples
for new deployments, not automatic moves of existing `/var/lib/helen/` data.

**GitHub Pages cannot host the server.** GitHub Pages is static-only. The server must be
separately deployed to a platform that supports running Node.js (Render, Railway, Fly.io, etc.).

---

## Commands

```bash
# Install dependencies
npm ci --legacy-peer-deps

# Start frontend dev server (http://localhost:3000)
npm run dev

# Production build (outputs to dist/)
npm run build

# Preview the production build locally
npm run preview

# Lint
npm run lint

# Run tests
npm test

# CLI smoke (non-interactive)
npm run cli -- --message "hello"

# Server – development (tsx hot reload)
npm run server:dev

# Server – typecheck / build
npm run server:typecheck
npm run server:build

# Experimental Python prototype smoke check
npm run python:smoke
```

### Dependency strategy

The repository intentionally uses a **single root lockfile** (`/package-lock.json`).
`server/` has its own `package.json` for scripts/configuration, but commands resolve compiler/runtime
tools from the root install (`../node_modules`). A second `server/package-lock.json` is not required.

---

## GitHub Pages deployment

> **Required manual step:** In repository Settings → Pages → Build and deployment → Source,
> select **GitHub Actions**. The site will remain blank if "Deploy from a branch" is selected,
> because that mode serves raw repository source files instead of the Vite build output.

The workflow (`.github/workflows/deploy.yml`):
1. Checks out the repository.
2. Runs `configure-pages` to record Pages metadata.
3. Installs dependencies with `npm ci --legacy-peer-deps`.
4. Builds with `npm run build` (outputs to `dist/`).
5. Verifies `dist/index.html` contains hashed asset paths and not `/src/main.tsx`.
   It also verifies `dist/favicon.svg` exists.
6. Uploads `dist/` as a Pages artifact.
7. Deploys via `actions/deploy-pages`.

The live URL is: `https://dmankv.github.io/Project-HELEN/`

Vite is configured with `base: '/Project-HELEN/'` to match this URL.

---

## GitHub Pages limitations

- **Static files only.** No server-side code or API keys.
- The Daemon cloud API must be hosted elsewhere if desired.
- All data (conversation history) is stored in the user's browser (`localStorage`).
- No analytics dashboard, no server-side memory – these are not deployed.
- `src/experimental/defself_l.py` is an experimental standalone prototype and is not used by Pages.

---

## CORS policy

The optional server (`server/index.ts`) allows cross-origin requests **only** from origins
listed in `DAEMON_ALLOWED_ORIGINS`. Requests from unknown origins are rejected for chat and auth.
Allowed preflight requests return `204`; disallowed preflight requests return `403`.

---

## Authentication deployment plan

### Option A — Managed auth via Supabase (recommended for GitHub Pages)

Supabase provides email/password sign-up, sign-in, session persistence, password reset, and
email verification from a browser-only SDK — no custom backend is required for the core auth flow.

#### One-time Supabase setup

1. Create a free project at https://supabase.com (free tier supports up to 50 000 MAUs).
2. In the Supabase dashboard, go to **Authentication → URL Configuration** and set:
   - **Site URL:** `https://dmankv.github.io/Project-HELEN/`
   - **Redirect URLs** (add both):
     ```
     https://dmankv.github.io/Project-HELEN/#/verify-email
     https://dmankv.github.io/Project-HELEN/#/reset-password
     ```
3. Copy two values from **Settings → API**:
   - **Project URL** (`https://your-project-id.supabase.co`)
   - **anon / public** key
4. In the GitHub repository, go to **Settings → Secrets and variables → Actions → Variables** tab
   and create:
   - `VITE_SUPABASE_URL` = the project URL from step 3
   - `VITE_SUPABASE_ANON_KEY` = the anon key from step 3
5. Trigger a new Pages deployment (push to `main` or **Actions → Deploy to GitHub Pages → Run workflow**).

Authentication is then live at `https://dmankv.github.io/Project-HELEN/#/login`.

#### Initial admin bootstrap + RBAC migration (required)

Apply the migration below in Supabase Dashboard SQL Editor (or another provider-side privileged context):

```
supabase/migrations/20260824143000_managed_auth_rbac.sql
```

What it enforces:
- `public.profiles` table keyed by `auth.users.id`.
- `role` constrained to `user` or `admin`.
- automatic profile creation trigger on new auth users.
- RLS enabled with own-row read/update policies only.
- trigger guard that blocks role/id changes unless the request context is `service_role`.

Bootstrap first admin (provider-side SQL only; never from browser code):

```sql
update public.profiles
set role = 'admin'
where id = (
  select id
  from auth.users
  where lower(email) = lower('<admin-email>')
);
```

Revoke/demote admin:

```sql
update public.profiles
set role = 'user'
where id = (
  select id
  from auth.users
  where lower(email) = lower('<user-email>')
);
```

Emergency recovery (no admins left):
1. Open Supabase Dashboard SQL Editor as project owner/admin.
2. Verify the target account UUID/email in `auth.users`.
3. Re-run the bootstrap promotion query above for a trusted operator account.

#### What the anon key is and is not

The Supabase anon key is the **publishable browser key**; it is intentionally embedded in the
built JavaScript. It is safe to embed because Supabase Row Level Security (RLS) policies on the
database side control what an unauthenticated or user-scoped token can access.

**Never embed** the Supabase service-role key, JWT secret, or any other private credential in the
frontend build. Those values must remain in server-side environments only.

#### Unconfigured behavior

When `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are absent (e.g. no Actions variables set):

- The build succeeds normally.
- The auth forms show: *"Managed authentication is not configured. Add
  VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY as GitHub Actions variables and redeploy."*
- The submit button is disabled; no broken requests are made.
- The local Daemon chat continues to work as normal.
- The app does not expose admin write operations from the static client; it only renders account role status.

#### CSP

When `VITE_SUPABASE_URL` is set at build time, `vite.config.ts` automatically adds that
Supabase project origin to the `connect-src` CSP directive in `dist/index.html` so the
browser can reach the Supabase API.

---

### Option B — Self-hosted Node auth (optional fallback)

1. **Frontend (GitHub Pages):**
   - Static React app (`/Project-HELEN/`).
   - Uses hash routes for `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`.
   - Uses cookie-based auth via `credentials: include`; no auth secrets in browser storage.

2. **API (separate Node host):**
   - Hosts `/api/chat` and `/api/auth/*`.
   - Enforces exact origin allow-list + CSRF token check for state-changing auth requests.
   - Requires an active session for browser chat; `DAEMON_API_TOKEN` is optional for non-browser clients.
   - Stores users/sessions/tokens in `AUTH_DATA_FILE` with atomic writes.
   - Hashes passwords with `scrypt`; never stores plaintext passwords.
   - Uses opaque, server-managed `HttpOnly` session cookies.

3. **Email adapter:**
   - Current repository implementation writes verification/reset messages to local outbox file for development/testing.
   - Production operator must integrate an actual SMTP/transactional email provider adapter before launch.

### Required operator actions before production launch

- Deploy `server/index.ts` to a Node host with HTTPS termination (Render/Railway/Fly/etc.).
- Mount `AUTH_DATA_FILE` on durable, encrypted storage not checked into source control.
- Configure `DAEMON_ALLOWED_ORIGINS` to exact frontend origin(s), including `https://dmankv.github.io`.
- Set `DAEMON_FRONTEND_URL=https://dmankv.github.io/Project-HELEN/`.
- Configure `AUTH_REQUIRE_HTTPS=true` and `AUTH_SECURE_COOKIES=true`.
- Replace development email outbox behavior with real provider integration for user-facing emails.
- Build frontend with `VITE_DAEMON_AUTH_API_URL`/`VITE_DAEMON_API_URL` pointing to the deployed API.
- Do not expose `DAEMON_API_TOKEN` through a `VITE_` build variable; Vite variables are public in the static bundle.

### Threat model and limitations

Covered:
- Password hashing at rest, token hashing at rest, token expiry + single-use, session revocation on reset.
- CSRF protections for cookie auth, exact allowed-origin CORS, and endpoint rate limiting.
- Generic responses for registration/login/reset/verification to reduce account enumeration.

Not fully covered by repository-only code:
- No built-in managed database provisioning/migration system.
- Development email adapter does not deliver real emails.
- No MFA, device/session management UI, account lockout workflow, or centralized audit logging pipeline.
- File-based auth store is suitable for local/dev and simple single-instance deployments; production at scale should migrate to a managed DB adapter.

---

## Live evaluation CI (`live-eval.yml`)

The `live-eval.yml` workflow runs daily at 07:00 UTC and on manual dispatch. It sends real
requests to a deployed backend to verify end-to-end behaviour. It is **no-op by default**:
if the required secrets are not configured the workflow emits a skip message and exits 0.

To enable live evaluation, provision the following repository secrets in
**Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `DAEMON_EVAL_API_URL` | Base URL of the deployed server (e.g. `https://your-server.example.com`) |
| `DAEMON_EVAL_API_TOKEN` | Non-browser token sent as `X-DAEMON-API-TOKEN` in evaluation requests |
| `DAEMON_EVAL_ORIGIN` | The allowed origin the evaluation runner presents to the server |

All three secrets must be set for live evaluation to run.

---

## Backend-mode deployment checklist

When connecting the frontend to a hosted backend, follow these steps **in order**:

1. Deploy `server/` to a platform that supports Node.js (Render, Railway, Fly.io, etc.).
2. Set the server's runtime environment variables:
   - `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (depending on provider)
   - `DAEMON_ALLOWED_ORIGINS` — must include **exactly** the deployed GitHub Pages URL:
     `https://dmankv.github.io`
   - `AUTH_DATA_FILE`, `DAEMON_FRONTEND_URL`, `AUTH_REQUIRE_HTTPS=true`, and
     `AUTH_SECURE_COOKIES=true`
   - `DAEMON_API_TOKEN` only when non-browser clients such as live evaluation need it
3. Rebuild and redeploy the **frontend** with the build-time variables set:
   - `VITE_DAEMON_API_URL` — the server base URL from step 1
   - `VITE_DAEMON_AUTH_API_URL` — optional explicit auth API URL
   - Do not set a `VITE_DAEMON_API_TOKEN`; Vite values are readable by every browser user.

> **Why a full rebuild is required:** `VITE_DAEMON_API_URL` is baked into the `dist/` artifact
> at build time by the Vite CSP plugin, which patches `connect-src` in `dist/index.html` to
> include the backend origin. If you deploy the existing `dist/` artifact and then set env vars
> at runtime, the browser will block every API call with a CSP violation. A rebuild and redeploy
> via the `deploy.yml` workflow (triggered on push to `main`) is the correct path.

4. After the deployment workflow succeeds, register, verify, and log into an account before
   sending cloud chat requests. Requests without an active session show `⚠️ Auth error` and
   fall back to local responses.
