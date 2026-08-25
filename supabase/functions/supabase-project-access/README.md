# Supabase project access Edge Function

`supabase-project-access` is the server-side boundary for optional, user-owned
Supabase diagnostics. It uses the hosted Supabase MCP endpoint only with:

- one selected `project_ref`
- `read_only=true`
- `features=debugging`

The browser receives only bounded, redacted, on-demand log results. It never
receives an OAuth token, management token, refresh token, or secret value.

## Deploy

The OAuth callback is a browser redirect and cannot carry an application JWT,
so deploy this function with gateway JWT verification disabled. The function
verifies JWTs itself for every non-callback request.

```bash
supabase functions deploy supabase-project-access --no-verify-jwt
supabase functions deploy supabase-project-secret-write
```

Apply `supabase/migrations/20260825083000_supabase_project_access.sql` before
using either function.

## Required server-only configuration

Set these as Supabase Function secrets, never as `VITE_*` variables:

```bash
# 32 random bytes, base64url encoded; generate and retain outside the repo.
supabase secrets set SUPABASE_PROJECT_ACCESS_ENCRYPTION_KEY=...

# Values registered for this server-side OAuth client.
supabase secrets set SUPABASE_MCP_OAUTH_CLIENT_ID=...
supabase secrets set SUPABASE_MCP_OAUTH_AUTHORIZATION_ENDPOINT=https://...
supabase secrets set SUPABASE_MCP_OAUTH_TOKEN_ENDPOINT=https://...

# Required when the OAuth provider requires a confidential client.
supabase secrets set SUPABASE_MCP_OAUTH_CLIENT_SECRET=...

# Recommended for refresh-token access and immediate provider revocation.
supabase secrets set SUPABASE_MCP_OAUTH_SCOPES=offline_access
supabase secrets set SUPABASE_MCP_OAUTH_REVOCATION_ENDPOINT=https://...

# Secret writes require a separately registered OAuth client. Its client ID
# must differ from SUPABASE_MCP_OAUTH_CLIENT_ID and have only the provider
# permissions needed for secret writes.
supabase secrets set SUPABASE_MCP_SECRET_WRITE_CLIENT_ID=...
supabase secrets set SUPABASE_MCP_SECRET_WRITE_CLIENT_SECRET=...
supabase secrets set SUPABASE_MCP_SECRET_WRITE_OAUTH_SCOPES=offline_access

# The exact callback URL registered with the OAuth client.
supabase secrets set \
  SUPABASE_PROJECT_ACCESS_REDIRECT_URI=https://<gateway-project-ref>.supabase.co/functions/v1/supabase-project-access

# Allowed post-consent application destination.
supabase secrets set \
  SUPABASE_PROJECT_ACCESS_APP_URL=https://dmankv.github.io/Project-HELEN/
```

Use the Supabase MCP connection/dashboard flow to register the OAuth client and
obtain the provider's authorization/token/revocation endpoints. The endpoint
values are server-side configuration, not values submitted by a browser user.
Register a distinct OAuth client for `write_secrets`; URL parameters such as
`read_only` are application constraints and do not replace provider-enforced
OAuth client scopes.

## Read-only log access

1. A signed-in user enters a project reference and explicitly checks the
   consent box.
2. The function saves only a hashed OAuth state and encrypted PKCE verifier,
   then redirects to the configured OAuth provider.
3. The callback exchanges the authorization code server-side. Only an
   AES-GCM-encrypted refresh token is retained; access tokens are refreshed
   per request and never stored.
4. A log request is owner-checked, rate-limited, time-bounded to one hour,
   and capped at 100 displayed entries.
5. Authorization headers, keys, passwords, JWTs, email addresses, IP
   addresses, and sensitive JSON fields are redacted before the result leaves
   the function. Results are marked untrusted.

Log content is not stored in Supabase tables or audit records. Audit rows
contain only the action, project reference, service, time window, and returned
entry count.

## Secret health and writes

The hosted read-only MCP debugging toolset does not safely expose a remote
project's secret inventory. `secret-health` therefore reports only configured
or missing status for allow-listed Edge Function secrets when the selected
connection is this gateway's own Supabase project. It otherwise returns
`unavailable`; it never calls a secret-list endpoint that could return values.

Secret creation and rotation are separate from read-only access:

1. Obtain a separate `write_secrets` OAuth connection through the
   `start-secret-write` action, which requires a second explicit consent and
   uses the distinct secret-write OAuth client.
2. Call `supabase-project-secret-write` with `confirmed: true` and an exact
   `confirmSecretName` match.
3. The function forwards the value once to Supabase, never reads the response
   body, never returns the value, and never writes it to an audit row, console
   log, conversation, or database.

Do not add a secret value to a chat message. The static frontend intentionally
does not provide a secret-entry form.

## Disconnect and revocation

`disconnect` owner-checks the connection, calls the configured OAuth
revocation endpoint when available, deletes the encrypted refresh token
immediately, and appends a value-free audit event. Deleting the local
connection always removes Project-HELEN's ability to use the token, even if a
remote revocation endpoint is temporarily unavailable.

`SUPABASE_PROJECT_ACCESS_ENCRYPTION_KEY` is versioned as `v1` ciphertext but
does not currently support transparent key rotation. If it must be replaced,
disconnect existing connections (or delete their rows) and require users to
reconnect; do not try to decrypt or migrate tokens outside a privileged
server-side context.
