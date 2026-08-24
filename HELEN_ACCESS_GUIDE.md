# HELEN – Access Guide

## Live site

**GitHub Pages:** https://dmankv.github.io/Project-HELEN/

> If the page is blank, see the **Deployment** section below.

---

## Quick start (local development)

```bash
git clone https://github.com/dmankv/Project-HELEN.git
cd Project-HELEN
npm ci --legacy-peer-deps
npm run dev          # http://localhost:3000
```

No environment variables are needed for local use. HELEN's built-in
rule/template-based engine responds without any external API.

CLI access (local terminal mode):

```bash
npm run cli
npm run cli -- --message "hello"
```

---

## How HELEN works

The browser loads `index.html` → `src/main.tsx` → `src/App.tsx` → `src/components/HelenInterface.tsx`.

All chat responses are generated locally by `src/services/helenResponseBrain.ts`
unless `VITE_HELEN_API_URL` is set at build time, in which case requests are forwarded to the
separately hosted `server/` API proxy.

**The current response engine is rule/template-based**, not an LLM. Responses are pattern-matched
from a set of predefined templates. No seven-step AI pipeline is implemented in the frontend.

---

## Optional cloud API

To connect HELEN to an LLM (OpenAI or Anthropic):

1. Deploy `server/index.ts` to a Node.js-capable host (not GitHub Pages).
2. Set the required server environment variables (see `DEPLOYMENT.md`).
3. Build the frontend with:
   ```bash
   VITE_HELEN_API_URL=https://your-server.example.com \
   npm run build
   ```
4. Deploy `dist/` to GitHub Pages (or any static host).

API keys are **only** stored on the server; they are never sent to the browser.

---

## Memory

Conversation history is stored in browser `localStorage` by `src/services/helenMemory.ts`.
It persists in that browser profile until cleared and is not synced to any server.

The repository also contains separate CLI/prototype files (`bin/helen.sh`, `bin/helen-cli.py`,
`src/cli/helen-cli.ts`, `src/experimental/defself_l.py`) that are not part of the deployed web app path.
`src/experimental/defself_l.py` is an experimental standalone prototype.

---

## Deployment

For full deployment instructions, environment variables, and CI/CD details see
[DEPLOYMENT.md](./DEPLOYMENT.md).

**GitHub Pages source must be set to "GitHub Actions"** in repository settings or the live site
will display a blank page (the raw `index.html` source instead of the Vite build output).

---

## Support

- GitHub Issues: https://github.com/dmankv/Project-HELEN/issues
