# Autonomous Evolution Backend Configuration

This repository now supports **opt-in backend configuration** for autonomous self-write and canary/promotion.

## Default behavior

Defaults are fail-closed:

- `DAEMON_EVOLUTION_SANDBOX_MODE=denied`
- `DAEMON_EVOLUTION_CANARY_MODE=denied`

When denied, autonomous write/promotion is blocked.

## Immutable control-plane inputs

Set these as server-side secrets/environment values (never in browser variables):

- `DAEMON_EVOLUTION_SANDBOX_MODE` (`denied` or `configured`)
- `DAEMON_EVOLUTION_CANARY_MODE` (`denied` or `configured`)
- `DAEMON_EVOLUTION_BACKEND_ID` (non-empty backend controller id)
- `DAEMON_EVOLUTION_MAX_FILE_BYTES` (positive integer)
- `DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE` (`true`/`false`)

## Backend infrastructure required before enabling configured mode

1. Isolated execution backend for sandbox writes/tests.
2. Protected canary deployment backend that is separate from direct `main` writes.
3. Immutable rollback authority outside Daemon writable scope.
4. Budget controls (runtime/API/spend) enforced by infrastructure.
5. Append-only audit pipeline for evolution run events.
6. Admin-only observability path.

## Admin diagnostics query

`supabase/functions/admin-daemon` now supports:

```json
{ "request_type": "evolution_status" }
```

Response returns non-secret configuration status only:

- `sandbox_mode`
- `canary_mode`
- `backend_configured`
- `auto_promote_enabled`
- `max_file_bytes`

## Promotion workflow

Use `.github/workflows/evolution-canary.yml` to trigger canary deployment through immutable backend integration.
It requires:

- `DAEMON_EVOLUTION_CANARY_ENABLED=true`
- `EVOLUTION_CANARY_BACKEND_URL`
- `EVOLUTION_CANARY_BACKEND_TOKEN`
- passing regression gate artifact from `live-eval.yml`.
