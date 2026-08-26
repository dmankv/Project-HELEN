# Daemon – Access Guide

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

No environment variables are needed for local use. Daemon's built-in
rule/template-based engine responds without any external API.

CLI access (local terminal mode):

```bash
npm run cli
npm run cli -- --message "hello"
```

---

## How Daemon works

The browser loads `index.html` → `src/main.tsx` → `src/App.tsx` → `src/components/DaemonInterface.tsx`.

All chat responses are generated locally by `src/services/daemonResponseBrain.ts`
unless `VITE_DAEMON_API_URL` is set at build time, in which case requests are forwarded to the
separately hosted `server/` API proxy.

**The current response engine is rule/template-based**, not an LLM. Responses are pattern-matched
from a set of predefined templates. No seven-step AI pipeline is implemented in the frontend.

---

## Authentication on GitHub Pages

The static Pages site supports real account authentication via **Supabase** — a managed
provider whose browser SDK requires no custom backend for sign-up, sign-in, session
persistence, password reset, and email verification.

### Quick setup (one-time)

1. Create a free Supabase project at https://supabase.com.
2. In **Authentication → URL Configuration**, set:
   - **Site URL:** `https://dmankv.github.io/Project-HELEN/`
   - **Redirect URLs:** `https://dmankv.github.io/Project-HELEN/#/verify-email`
     and `https://dmankv.github.io/Project-HELEN/#/reset-password`
3. Copy the **Project URL** and **anon public key** from **Settings → API**.
4. In **GitHub → Settings → Secrets and variables → Actions → Variables**, add:
   - `VITE_SUPABASE_URL` — the project URL
   - `VITE_SUPABASE_ANON_KEY` — the anon key
5. Trigger a new Pages build (push to `main`).
6. In Supabase Dashboard SQL Editor, apply:
   - `supabase/migrations/20260824143000_managed_auth_rbac.sql`
7. Bootstrap first admin in Supabase SQL Editor (provider-side only):
   ```sql
   update public.profiles
   set role = 'admin'
   where id = (
     select id from auth.users where lower(email) = lower('<admin-email>')
   );
   ```

Authentication flows are then available at `#/login`, `#/register`, `#/forgot-password`,
`#/reset-password`, and `#/verify-email`.

> **Without these variables:** auth forms display a clear "not configured" notice. The
> rest of the app (local Daemon chat) continues to work normally — no broken requests.
>
> The static client never stores privileged keys and cannot self-promote to admin; role changes
> require provider-side privileged SQL.

For full setup details see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Optional cloud API

To connect Daemon to an LLM (OpenAI or Anthropic):

1. Deploy `server/index.ts` to a Node.js-capable host (not GitHub Pages).
2. Set the required server environment variables (see `DEPLOYMENT.md`).
3. Build the frontend with:
   ```bash
   VITE_DAEMON_API_URL=https://your-server.example.com \
   npm run build
   ```
4. Deploy `dist/` to GitHub Pages (or any static host).

API keys are **only** stored on the server; they are never sent to the browser.

---

## Optional GitHub issue access

Signed-in users can optionally connect a private GitHub App installation to
create issues in explicitly selected repositories. The channel creates issues
only—it cannot commit files, open pull requests, alter workflows, manage
secrets, or change repository settings.

Host the write-enabled frontend on a dedicated HTTPS custom origin, not a
`github.io` project site. GitHub Pages projects share browser storage for an
account-wide origin, so GitHub issue writes remain disabled there.

1. Create a private GitHub App with **Issues: Read and write** and no broader
   repository permissions.
2. Apply `supabase/migrations/20260825162000_github_write_access.sql`.
3. Configure the App callback as
   `https://<gateway-project-ref>.supabase.co/functions/v1/github-write-access`.
4. Set GitHub App credentials only as Supabase Function secrets, then deploy:
   ```bash
   supabase functions deploy github-write-access --no-verify-jwt
   supabase functions deploy github-write
   ```
5. In the sidebar, authorize GitHub, select an eligible repository, connect it
   for `create_issue`, then review and explicitly confirm every issue.

The browser never receives a GitHub App private key, OAuth credential, App JWT,
or installation token. For the complete secret list, PKCS#8 key requirement,
revocation, and rotation procedure, see
[`supabase/functions/github-write-access/README.md`](./supabase/functions/github-write-access/README.md).

---

## Memory

Conversation history is stored in browser `localStorage` by `src/services/daemonMemory.ts`.
It persists in that browser profile until cleared and is not synced to any server.

The repository also contains separate CLI/prototype files (`bin/daemon.sh`, `bin/daemon-cli.py`,
`src/cli/daemon-cli.ts`, `src/experimental/defself_l.py`) that are not part of the deployed web app path.
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
