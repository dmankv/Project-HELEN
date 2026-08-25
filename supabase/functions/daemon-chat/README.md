# daemon-chat Edge Function

Supabase Edge Function for authenticated, rate-limited Daemon AI chat.

## What it does

- **Verifies** the caller's Supabase JWT before any provider call
- **Rate limits** per authenticated user (60 req / 60 s), tracked in `public.edge_rate_limits`
- **Validates** message schema, size, turn count, and allowed roles
- **Calls** OpenAI or Anthropic using secrets stored only in Supabase Function secrets
- **Returns** a narrowly defined `{ message: string }` response
- **Applies CORS** only for `https://dmankv.github.io` and localhost (dev)

## One-time deployment steps

### 1. Set secrets (server-only — never commit values)

```bash
supabase secrets set OPENAI_API_KEY=sk-...
# or
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set DAEMON_PROVIDER=anthropic   # default: openai
supabase secrets set DAEMON_MODEL=claude-3-5-haiku-20241022   # optional
```

### 2. Deploy the function

```bash
supabase functions deploy daemon-chat
```

> GitHub Pages does **not** deploy this function. The frontend and the Supabase Edge Function
> are separate deployment targets.

### 3. Apply database migration

Run `supabase/migrations/20260824160000_daemon_persistence.sql` in the Supabase SQL Editor (or via CLI).

This creates the `edge_rate_limits` table and other user-owned tables.

### 4. Verify

```bash
curl -X POST https://<project>.supabase.co/functions/v1/daemon-chat \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## Environment variables summary

| Variable | Where | Description |
|---|---|---|
| `OPENAI_API_KEY` | Supabase Function secret | OpenAI secret key (never in browser) |
| `ANTHROPIC_API_KEY` | Supabase Function secret | Anthropic secret key (never in browser) |
| `DAEMON_PROVIDER` | Supabase Function secret | `openai` or `anthropic` |
| `DAEMON_MODEL` | Supabase Function secret | Model name override |
| `SUPABASE_URL` | Auto-injected by Supabase | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | Service role (rate limit writes) |
| `VITE_SUPABASE_URL` | GitHub Actions variable | Public project URL (safe in browser) |
| `VITE_SUPABASE_ANON_KEY` | GitHub Actions variable | Public anon key (safe in browser) |

## Safe error codes

`daemon-chat` returns only the following machine-readable error codes on failure:

- `AUTH_REQUIRED`
- `INVALID_TOKEN`
- `RATE_LIMITED`
- `FUNCTION_CONFIG_ERROR`
- `PROVIDER_UNAVAILABLE`
- `BAD_REQUEST`
- `ORIGIN_NOT_ALLOWED`
- `METHOD_NOT_ALLOWED`
- `INTERNAL_ERROR`

The function does **not** return provider bodies, stack traces, SQL errors, tokens, or prompt
contents to the browser.

## Operator checks

When the frontend falls back to local mode, verify these items in order:

1. **Edge Functions → `daemon-chat` → Deployment**: confirm the function exists and the latest deploy succeeded.
2. **Edge Functions → `daemon-chat` → Logs**: look for the safe codes above.
3. **Function secrets/runtime config**: verify `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`,
   `DAEMON_PROVIDER`, optional `DAEMON_MODEL`, plus Supabase-injected runtime variables.
4. **Frontend build variables**: confirm the GitHub Pages build was given only
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as public values.

## Rate limiting

Rate limits are enforced server-side in `public.edge_rate_limits` using the service role. Browser state alone is never used for rate limiting.

## Security notes

- Provider API keys are never in the static GitHub Pages bundle
- The `Authorization` header containing the user JWT is required for every non-preflight request
- CORS is restricted to `https://dmankv.github.io` and localhost — no wildcard
- Internal provider errors are masked; only a generic message is returned to the client
