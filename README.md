# HELEN — Adaptive AI Assistant

Live site: https://dmankv.github.io/Project-HELEN/

HELEN is a React/TypeScript chat interface with:

- **Static GitHub Pages frontend** (`/Project-HELEN/`)
- **Separately hosted Node.js API** for optional cloud chat and production-oriented authentication

| Mode | When | Indicator |
|---|---|---|
| **Local brain** | Default / backend unavailable | 🖥️ Local (sidebar) |
| **Cloud model** | `VITE_HELEN_API_URL` is set and server is running | ☁️ Cloud (sidebar) |

The frontend is always functional without a backend.

---

## Production frontend path

The authoritative frontend implementation follows this import chain:

```
index.html
  └─ src/main.tsx
       └─ src/App.tsx
            └─ src/components/HelenInterface.tsx
                 └─ src/services/helenResponseBrain.ts  (local rule engine)
                 └─ src/services/helenChatAPI.ts        (optional cloud API)
                 └─ src/services/helenMemory.ts         (browser localStorage)
                 └─ src/styles/HelenInterface.css
```

`HelenInterface.tsx` is the sole active web chat component.
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
VITE_HELEN_API_URL=http://localhost:3001 npm run dev
```

### Backend environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `HELEN_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | If openai | — | OpenAI secret key |
| `ANTHROPIC_API_KEY` | If anthropic | — | Anthropic secret key |
| `HELEN_MODEL` | No | `gpt-4o-mini` / `claude-3-haiku-20240307` | Model name |
| `HELEN_ALLOWED_ORIGINS` | No | `http://localhost:3000,http://localhost:4173` | CORS allowed origins |
| `HELEN_FRONTEND_URL` | No | `http://localhost:3000/Project-HELEN/` | Used for verify/reset email links |
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
| `HELEN_RATE_LIMIT` | No | `60` | Max requests per IP per minute |
| `HELEN_TRUST_PROXY` | No | _(unset)_ | Set to `1` behind a reverse proxy so the rate limiter reads the real client IP from `X-Forwarded-For`. Leave unset when the server faces the internet directly. |

### Frontend environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_HELEN_API_URL` | No | _(empty — uses local brain)_ | URL of HELEN API server |
| `VITE_HELEN_AUTH_API_URL` | No | `VITE_HELEN_API_URL` | Optional explicit auth API URL |

---

## Authentication architecture (production-oriented)

The frontend remains static (GitHub Pages). Authentication is handled by the separately hosted Node API:

- `POST /api/auth/register` (generic response, no enumeration)
- `POST /api/auth/verification/request`
- `POST /api/auth/verify-email`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `POST /api/auth/password-reset/request`
- `POST /api/auth/password-reset/confirm`
- `GET /api/auth/csrf`

Security properties:

- Passwords are hashed server-side using Node `scrypt` with per-password random salts.
- Sessions are opaque server-managed IDs in `HttpOnly` cookies (`SameSite=Lax`, `Secure` in HTTPS deployments).
- CSRF protection uses Origin allow-list checks + double-submit token (`X-CSRF-Token` + cookie).
- Verification/reset tokens are random, hashed at rest, single-use, purpose-scoped, and expiration-bound.
- Login/register/reset/verify endpoints are rate-limited.
- Password reset revokes all existing sessions for that account.
- Auth data persists in `AUTH_DATA_FILE` (local/dev default) and must be placed on durable encrypted storage in production.
- Development/test email delivery uses file outbox adapter (`AUTH_DEV_EMAIL_OUTBOX_FILE`).

> If you need managed production email/database providers, wire provider adapters via environment configuration before launch. This repository ships a safe local development/test adapter, not a hosted email service configuration.

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
HELEN_EVAL_LIVE=true npm test         # also runs live model tests (requires backend)
```

---

## Production deployment

### Frontend (GitHub Pages — current)

The frontend builds as a static site and is deployed via the existing GitHub Actions workflow.
No secrets go to the browser. The `VITE_HELEN_API_URL` env var can be left unset for full
static operation, or set to a deployed server URL.

### Backend (serverless / Node)

Deploy `server/index.ts` to any Node.js host:

- **Vercel Functions** — rename to `api/chat.ts` and adapt to the Vercel edge handler signature.
- **Netlify Functions** — similarly adapt to the Netlify handler signature.
- **Fly.io / Railway / Render** — deploy as a plain Node.js service with `npm run server:dev` or `node dist/index.js` after `npm run build`.

Set `HELEN_ALLOWED_ORIGINS` to the GitHub Pages URL for production.

---

## Non-web CLI/Python entrypoints (status)

These files are **not** used by the deployed React/Vite website:

- `src/cli/helen-cli.ts` (supported local CLI, run with `npm run cli`)
- `bin/helen.sh` / `bin/helen-cli.py` (wrappers for the same TypeScript CLI)
- `src/services/defself_l.py` (experimental standalone Python prototype)

The CLI intentionally uses local, in-process logic and does not import browser-only services.
The Python prototype is not part of the web build/deploy/runtime path.

---

## Architecture

```
Browser (GitHub Pages)
  └── HelenInterface.tsx
        ├── helenChatAPI.ts  ──→  HELEN API Server (optional)
        │                              └── OpenAI / Anthropic
        ├── helenResponseBrain.ts  (local fallback, always available)
        └── helenMemory.ts  (localStorage, upgrade to DB/vector store)
```

---

## Specification

See [docs/HELEN_SPEC.md](docs/HELEN_SPEC.md) for the personality, safety, and evaluation specification.
