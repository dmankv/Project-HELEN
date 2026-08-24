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
| `src/components/DaemonInterface.tsx` | Chat UI, message list, input |
| `src/services/daemonResponseBrain.ts` | Rule/template-based local response engine |
| `src/services/daemonChatAPI.ts` | HTTP client for optional cloud API |
| `src/services/daemonMemory.ts` | In-browser durable memory persisted in localStorage until cleared |

---

## Optional backend (`server/`)

`server/index.ts` is a minimal Node.js HTTP gateway (no Express).
It proxies `POST /api/chat` to OpenAI or Anthropic using server-side credentials.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAEMON_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | When provider=openai | – | OpenAI secret key |
| `ANTHROPIC_API_KEY` | When provider=anthropic | – | Anthropic secret key |
| `DAEMON_MODEL` | No | provider default | Override model name |
| `DAEMON_ALLOWED_ORIGINS` | No | `http://localhost:3000,http://localhost:4173` | Comma-separated allowed CORS origins |
| `PORT` | No | `3001` | Listening port |
| `DAEMON_RATE_LIMIT` | No | `60` | Max requests per IP per minute |
| `DAEMON_TRUST_PROXY` | No | _(unset)_ | Set to `1` when deployed behind a reverse proxy (Vercel, Fly.io, nginx, etc.) so the rate limiter reads the real client IP from `X-Forwarded-For` instead of the proxy's socket address. **Leave unset when the server faces the internet directly** to prevent IP-spoofing. |

Frontend variable (set at Vite build time):

| Variable | Description |
|----------|-------------|
| `VITE_DAEMON_API_URL` | Full URL to server (e.g. `https://your-server.example.com`). Omit to use local mode. |

> **CSP note:** When `VITE_DAEMON_API_URL` is set, `vite.config.ts` automatically adds that
> server's origin to the `connect-src` directive of the built HTML's Content-Security-Policy,
> allowing the browser to reach the backend.  If you patch or replace `dist/index.html` after
> the build, ensure `connect-src` includes your server's origin — otherwise every API call
> will be blocked by the browser with a CSP violation.

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
- `src/services/defself_l.py` is an experimental standalone prototype and is not used by Pages.

---

## CORS policy

The optional server (`server/index.ts`) allows cross-origin requests **only** from origins
listed in `DAEMON_ALLOWED_ORIGINS`. Requests from unknown origins receive no
`Access-Control-Allow-Origin` header. The server never echoes back an untrusted origin.
Allowed CORS preflight requests return `204`; disallowed preflight requests return `403`.
