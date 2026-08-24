# Daemon — Adaptive AI Assistant

Live site: https://dmankv.github.io/Project-HELEN/

Daemon is a React/TypeScript chat interface with:

- **Static GitHub Pages frontend** (`/Project-HELEN/`)
- **Separately hosted Node.js API** for optional cloud chat and production-oriented authentication

| Mode | When | Indicator |
|---|---|---|
| **Local brain** | Default / backend unavailable | 🖥️ Local (sidebar) |
| **Cloud model** | `VITE_DAEMON_API_URL` is set and server is running | ☁️ Cloud (sidebar) |

The frontend is always functional without a backend.

---

## Production frontend path

The authoritative frontend implementation follows this import chain:

```
index.html
  └─ src/main.tsx
       └─ src/App.tsx
            └─ src/components/DaemonInterface.tsx
                 └─ src/services/daemonResponseBrain.ts  (local rule engine)
                 └─ src/services/daemonChatAPI.ts        (optional cloud API)
                 └─ src/services/daemonMemory.ts         (browser localStorage)
                 └─ src/styles/DaemonInterface.css
```

`DaemonInterface.tsx` is the sole active web chat component.
Some older CLI/non-web files still exist and are documented below as separate entrypoints.

---

## Quick start (local)

```bash
npm ci --legacy-peer-deps
npm run dev          # frontend at http://localhost:3000/Project-HELEN/
```

CLI (local terminal mode):

```bash
npm run cli
# one-shot non-interactive:
npm run cli -- --message "hello"
```

---

## Backend (optional chat, required for real auth)

```bash
# Start the API gateway
OPENAI_API_KEY=sk-... npm run server:dev

# Point the frontend at it
VITE_DAEMON_API_URL=http://localhost:3001 npm run dev
```

### Backend environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAEMON_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | If openai | — | OpenAI secret key |
| `ANTHROPIC_API_KEY` | If anthropic | — | Anthropic secret key |
| `DAEMON_MODEL` | No | `gpt-4o-mini` / `claude-3-haiku-20240307` | Model name |
| `DAEMON_ALLOWED_ORIGINS` | No | `http://localhost:3000,http://localhost:4173` | CORS allowed origins |
| `DAEMON_FRONTEND_URL` | No | `http://localhost:3000/Project-HELEN/` | Used for verify/reset email links |
| `DAEMON_API_TOKEN` | No | — | Optional token for non-browser `/api/chat` clients; never expose it through Vite |
| `PORT` | No | `3001` | Server port |
| `AUTH_DATA_FILE` | No | `.data/auth-store.json` | Persistent auth storage file (outside source control) |
| `AUTH_DEV_EMAIL_OUTBOX_FILE` | No | `.data/auth-email-outbox.jsonl` | Development/test email outbox |
| `AUTH_REQUIRE_HTTPS` | No | `true` in prod | Require HTTPS on sensitive auth endpoints |
| `AUTH_SECURE_COOKIES` | No | `true` in prod | Sets `Secure` on auth cookies |
| `AUTH_SESSION_TTL_MS` | No | `43200000` | Session lifetime (12h default) |
| `AUTH_VERIFY_TTL_MS` | No | `86400000` | Email verification token TTL |
| `AUTH_RESET_TTL_MS` | No | `1800000` | Password reset token TTL |
| `AUTH_RATE_LIMIT_MAX` | No | `20` | Auth endpoint rate-limit max per window |
| `AUTH_RATE_LIMIT_WINDOW_MS` | No | `60000` | Auth endpoint rate-limit window |
| `DAEMON_RATE_LIMIT` | No | `60` | Max requests per IP per minute |
| `DAEMON_RATE_LIMIT_WINDOW_MS` | No | `60000` | Chat rate-limit window |
| `DAEMON_TRUST_PROXY` | No | _(unset)_ | Set to `1` behind a reverse proxy so the rate limiter reads the real client IP from `X-Forwarded-For`. Leave unset when the server faces the internet directly. |

### Frontend environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_SUPABASE_URL` | No | _(empty)_ | Supabase project URL — enables managed auth on GitHub Pages (publishable) |
| `VITE_SUPABASE_ANON_KEY` | No | _(empty)_ | Supabase anon/public key (publishable, protected by RLS) |
| `VITE_DAEMON_API_URL` | No | _(empty — uses local brain)_ | URL of self-hosted Daemon API server (optional fallback) |
| `VITE_DAEMON_AUTH_API_URL` | No | `VITE_DAEMON_API_URL` | Optional explicit auth API URL for self-hosted path |

---

## Authentication

### Managed auth — Supabase (recommended for GitHub Pages)

The easiest way to enable real account sign-up/sign-in on the static GitHub Pages site is
**Supabase Auth**: no custom backend is needed for the core login/session flow.

**One-time Supabase setup:**

1. Create a free project at https://supabase.com.
2. In **Authentication → URL Configuration**, add the **Site URL**:
   ```
   https://dmankv.github.io/Project-HELEN/
   ```
   and add the following **Redirect URLs** (allow list):
   ```
   https://dmankv.github.io/Project-HELEN/#/verify-email
   https://dmankv.github.io/Project-HELEN/#/reset-password
   ```
3. Copy **Settings → API → Project URL** and **anon public** key.
4. In the GitHub repository, go to **Settings → Secrets and variables → Actions → Variables** tab
   and add:
   - `VITE_SUPABASE_URL` = `https://your-project-id.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `your-anon-public-key`
5. Trigger a new deployment (push to `main` or run **Actions → Deploy to GitHub Pages → Run workflow**).
6. Apply `supabase/migrations/20260824143000_managed_auth_rbac.sql` in the Supabase Dashboard SQL Editor.
7. In Supabase SQL Editor (privileged context), assign the first admin by UUID/email lookup:
   ```sql
   update public.profiles
   set role = 'admin'
   where id = (
     select id from auth.users where lower(email) = lower('<admin-email>')
   );
   ```

Authentication is then available at `https://dmankv.github.io/Project-HELEN/#/login`.

> The anon key is intentionally public and safe to embed. Never embed the Supabase service-role key,
> JWT secret, or any other private credential in the frontend build.
>
> Public build configuration is limited to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
> Keep service-role keys, provider admin API keys, and privileged tokens only in provider-side contexts.

**Unconfigured behaviour:** When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent, auth
forms show a clear "not configured" notice; the rest of the app (local Daemon chat) is unaffected.

**Admin revocation / recovery (provider-side only):**
- Demote an admin:
  ```sql
  update public.profiles set role = 'user' where id = '<user-uuid>';
  ```
- Emergency recovery when no admins remain: use Supabase Dashboard SQL Editor as project admin and
  promote a trusted account with the same `update ... set role = 'admin' ...` query above.

### Self-hosted auth (optional fallback)

The `server/` Node API provides authentication endpoints for operators who want to run their own
instance. Set `VITE_DAEMON_AUTH_API_URL` (or `VITE_DAEMON_API_URL`) to enable this path.
See `DEPLOYMENT.md` for full details.

---

## Memory commands

| Command | Effect |
|---|---|
| `remember this: <text>` | Store a durable memory |
| `what do you remember?` | List all durable memories |
| `forget this` | Delete the most recently saved memory |
| `forget: <phrase>` | Delete memories matching phrase |
| `forget all memories` | Erase all durable memories |
| **Clear** button | Clears conversation context only — durable memories are preserved |

---

## Tests

```bash
npm test                              # static unit tests (no network needed)
DAEMON_EVAL_LIVE=true npm test         # also runs live model tests (requires backend)
```

---

## Production deployment

### Frontend (GitHub Pages — current)

The frontend builds as a static site and is deployed via the existing GitHub Actions workflow.
No secrets go to the browser. The `VITE_DAEMON_API_URL` env var can be left unset for full
static operation, or set to a deployed server URL.

### Backend (serverless / Node)

Deploy `server/index.ts` to any Node.js host:

- **Vercel Functions** — rename to `api/chat.ts` and adapt to the Vercel edge handler signature.
- **Netlify Functions** — similarly adapt to the Netlify handler signature.
- **Fly.io / Railway / Render** — deploy as a plain Node.js service with `npm run server:dev` or `node dist/index.js` after `npm run build`.

Set `DAEMON_ALLOWED_ORIGINS` to the GitHub Pages URL for production.

---

## Non-web CLI/Python entrypoints (status)

These files are **not** used by the deployed React/Vite website:

- `src/cli/daemon-cli.ts` (supported local CLI, run with `npm run cli`)
- `bin/daemon.sh` / `bin/daemon-cli.py` (wrappers for the same TypeScript CLI)
- `src/experimental/defself_l.py` (experimental standalone Python prototype)

The CLI intentionally uses local, in-process logic and does not import browser-only services.
The Python prototype is not part of the web build/deploy/runtime path.

---

## Architecture

```
Browser (GitHub Pages)
  └── DaemonInterface.tsx
        ├── daemonChatAPI.ts  ──→  Daemon API Server (optional)
        │                              └── OpenAI / Anthropic
        ├── daemonResponseBrain.ts  (local fallback, always available)
        └── daemonMemory.ts  (localStorage, upgrade to DB/vector store)
```

---

## Specification

See [docs/DAEMON_SPEC.md](docs/DAEMON_SPEC.md) for the personality, safety, and evaluation specification.
