# GitHub App authenticated issue writes

`github-write-access` and `github-write` form a narrow, server-side GitHub App
integration. The only supported mutation is **creating a GitHub issue** in a
repository that the signed-in user explicitly connected.

This is not a generic GitHub API proxy. It cannot create pull requests, commit
files, alter workflows, manage secrets, change settings, or perform destructive
repository actions.

## Create the GitHub App

Create a **private** GitHub App owned by the account or organization that owns
the intended repositories.

1. Restrict installation to the intended owner and selected repositories.
2. Grant only these repository permissions:
   - **Issues: Read and write**
   - **Metadata: Read-only** (required by GitHub)
3. Do not grant Contents, Pull requests, Actions/Workflows, Secrets,
   Administration, or organization permissions.
4. Leave webhooks inactive until an inbound-event feature is separately
   designed and reviewed.
5. Set the App's user authorization callback URL exactly to:

   ```text
   https://<gateway-project-ref>.supabase.co/functions/v1/github-write-access
   ```

6. Generate an App private key and a client secret. Keep both outside the
   repository and browser.

The Edge Function uses Web Crypto and requires an unencrypted **PKCS#8** private
key (`-----BEGIN PRIVATE KEY-----`). GitHub may download a traditional
`-----BEGIN RSA PRIVATE KEY-----` file; convert it outside this repository:

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in /secure/path/github-app-private-key.pem \
  -out /secure/path/github-app-private-key.pkcs8.pem
```

## Apply storage and deploy

Apply `supabase/migrations/20260825162000_github_write_access.sql` before
deploying either function. It creates service-role-only OAuth state,
server-verified eligibility, repository connections, rate limits, idempotency,
and append-only audit records.

Set the following as **Supabase Function secrets**, never as `VITE_*` values:

```bash
# GitHub App identifiers and confidential credentials.
supabase secrets set GITHUB_APP_ID=...
supabase secrets set GITHUB_APP_CLIENT_ID=...
supabase secrets set GITHUB_APP_CLIENT_SECRET=...
supabase secrets set GITHUB_APP_PRIVATE_KEY="$(cat /secure/path/github-app-private-key.pkcs8.pem)"

# 32 random bytes encoded as base64url. Keep it distinct from all other keys.
supabase secrets set GITHUB_WRITE_ACCESS_ENCRYPTION_KEY=...

# Exact GitHub App callback and dedicated browser destination.
supabase secrets set \
  GITHUB_WRITE_ACCESS_REDIRECT_URI=https://<gateway-project-ref>.supabase.co/functions/v1/github-write-access
supabase secrets set \
  GITHUB_WRITE_ACCESS_APP_URL=https://github-write.example.com/
```

Generate the encryption value with a secure local command and store it only in
the Supabase secret manager, for example:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Host the write-enabled frontend on a dedicated HTTPS custom origin such as
`https://github-write.example.com/`. Do **not** configure
`GITHUB_WRITE_ACCESS_APP_URL` as a `github.io` project site: GitHub Pages
projects under one account share an origin and browser storage. The functions
fail closed for `*.github.io`; until a dedicated origin is available, leave
GitHub issue writes disabled. An explicitly configured `http://localhost` or
`http://127.0.0.1` origin is accepted only for local development.

Deploy the OAuth callback with gateway JWT verification disabled because
GitHub's redirect cannot carry the application's Supabase JWT. The function
consumes a one-time, server-stored state instead. The mutation function keeps
normal gateway JWT verification enabled and also validates the caller itself.

```bash
supabase functions deploy github-write-access --no-verify-jwt
supabase functions deploy github-write
```

GitHub Pages deploys only the static frontend; it does not deploy either Edge
Function or configure these secrets.

## Authorization and write flow

1. A signed-in Supabase user explicitly starts GitHub App authorization.
2. The function stores only a SHA-256 state hash and AES-GCM-encrypted PKCE
   verifier, each with a ten-minute expiry.
3. The callback atomically consumes the state, exchanges the authorization code
   server-side, reads the immutable GitHub user ID, and obtains repositories
   eligible to that GitHub user and App installation.
4. The short-lived GitHub user token is discarded. No user access token, refresh
   token, GitHub App JWT, or installation token is stored.
5. The user explicitly selects one cached, server-verified repository and
   confirms the `create_issue`-only connection. A connection expires after 24
   hours, requiring fresh GitHub user authorization and repository selection
   before another issue can be written; this bounds stale organization access.
6. Before each issue write, the function verifies the Supabase owner, explicit
   action and repository confirmation, server-side rate limit, idempotency key,
   and repository membership in the installation.
7. The function mints a short-lived installation token narrowed to the selected
   repository, creates one issue, discards the token, and returns only the issue
   number and URL.

Issue title and body are bounded to 256 bytes and 16 KiB respectively. They are
not written to audit tables or function logs; idempotency records retain only a
keyed digest, never the content or a raw deterministic hash. The frontend does
not submit Daemon output automatically; all issue text remains a user-reviewed
draft until the user checks the final confirmation.

## Revocation and key rotation

**Disconnect** deletes the local repository connection immediately, preventing
future Project-HELEN writes, and removes the cached repository choice so a new
GitHub authorization is required to reconnect it. Because the application never
retains GitHub user or installation tokens, there is no durable local credential
to revoke. To revoke the remote grant as well, remove the App installation or
revoke the App's user authorization in GitHub settings.

Rotate a GitHub App private key in GitHub, replace
`GITHUB_APP_PRIVATE_KEY` in Supabase secrets, and redeploy the functions. The
GitHub write encryption key protects short-lived PKCE state and derives opaque
idempotency digests; if it must be replaced, wait for the ten-minute state
expiry (or delete pending `github_write_oauth_states` rows with a privileged
migration) and require users to authorize again. Requests using an old
idempotency key safely fail rather than retrying a write. Never attempt to
decrypt or migrate credentials outside the server-side boundary.

First install the App on a non-production repository, create one deliberately
reviewed test issue, and verify that the audit record contains only action and
safe GitHub identifiers before enabling a production repository.
