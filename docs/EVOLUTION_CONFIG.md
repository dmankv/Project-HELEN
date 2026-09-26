# Autonomous Evolution Backend Configuration

This repository reserves backend configuration for autonomous self-write and canary/promotion. Configuration values are documented here as the immutable control-plane contract and diagnostics surface, but adapter selection in this repository remains fail-closed until a verified backend is injected.

## Default behavior

Defaults are fail-closed:

- `DAEMON_EVOLUTION_SANDBOX_MODE=denied`
- `DAEMON_EVOLUTION_CANARY_MODE=denied`

When denied, autonomous write/promotion is blocked.

## Reserved immutable control-plane inputs

Set these as server-side secrets/environment values (never in browser variables):

- `DAEMON_EVOLUTION_SANDBOX_MODE` (`denied` or `configured`)
- `DAEMON_EVOLUTION_CANARY_MODE` (`denied` or `configured`)
- `DAEMON_EVOLUTION_BACKEND_ID` (non-empty backend controller id)
- `DAEMON_EVOLUTION_MAX_FILE_BYTES` (positive integer)
- `DAEMON_EVOLUTION_ALLOW_AUTO_PROMOTE` (`true`/`false`)

These keys are intentionally reserved for verified backend integration. In the current repository state they document the required contract and are surfaced through admin diagnostics, but they do not by themselves enable non-denied adapters.

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
- `backend_id_configured`
- `auto_promote_enabled`
- `max_file_bytes`

## Promotion workflow

Use `.github/workflows/evolution-canary.yml` to trigger canary deployment through immutable backend integration.
It requires:

- `DAEMON_EVOLUTION_CANARY_ENABLED=true` as a GitHub Actions secret on the `evolution-canary` environment.
- `EVOLUTION_CANARY_BACKEND_URL` as a GitHub Actions secret on the `evolution-canary` environment.
- `EVOLUTION_CANARY_BACKEND_TOKEN` as a GitHub Actions secret on the `evolution-canary` environment.
- workflow input `candidate_sha` set to the full 40-character commit SHA for the promoted candidate.
- a successful `live-eval.yml` run for that exact SHA with a non-expired `evolution-gate-results` artifact bound to the same `candidate_sha`, `run_id`, `candidate_version`, and `candidate_snapshot_id`.
- exactly one required passed gate result for each of: `typecheck`, `lint`, `unit`, `build`, `security_scan`, `secret_scan`, `resource_budget`, and `regression`.
