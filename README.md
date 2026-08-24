# HELEN — Adaptive AI Assistant

Live site: https://jackdeadicay-boop.github.io/somthing/

HELEN is a React/TypeScript chat interface with two operating modes:

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
            ├─ src/components/HelenInterface.tsx
            │    └─ src/services/helenResponseBrain.ts  (local rule engine)
            │    └─ src/services/helenChatAPI.ts        (optional cloud API)
            │    └─ src/services/helenMemory.ts         (browser localStorage)
            │    └─ src/styles/HelenInterface.css
            ├─ src/components/LoginView.tsx
            └─ src/viewRouting.ts
```

`HelenInterface.tsx` is the sole active web chat component.
Some older CLI/non-web files still exist and are documented below as separate entrypoints.

The header includes a **Log in** button that opens a separate login view (`#/login`).
This form is currently UI-only and does **not** authenticate or send credentials to the chat API.

---

## Quick start (local)

```bash
npm ci --legacy-peer-deps
npm run dev          # frontend at http://localhost:3000/somthing/
```

CLI (local terminal mode):

```bash
npm run cli
# one-shot non-interactive:
npm run cli -- --message "hello"
```

---

## Backend (optional — enables cloud model responses)

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
| `PORT` | No | `3001` | Server port |

### Frontend environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_HELEN_API_URL` | No | _(empty — uses local brain)_ | URL of HELEN API server |

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
