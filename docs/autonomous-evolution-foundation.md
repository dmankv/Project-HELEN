# Daemon Autonomous Evolution Foundation (Production-Safe Baseline)

This foundation enables autonomous **candidate evolution** while keeping sensitive authority outside Daemon control.

## Threat model and authority boundary

Daemon may iterate on candidate behavior in an isolated sandbox flow, but it must never gain authority over:

- secrets and API keys;
- auth/admin-role enforcement;
- Supabase RLS policies;
- deployment credentials and production access controls;
- billing/spend controls and API budgets;
- audit logging and rollback controls.

Authority for the above remains in immutable infrastructure and protected environments.

## What is autonomous

The autonomous allowlist supports:

- read-only repository inspection;
- sandbox/lab writes and snapshots;
- experiment workspace creation;
- test execution;
- deterministic candidate evaluation;
- canary attempt through an explicit adapter.

## What is immutable/denied

The policy denylist blocks:

- direct writes to `main`;
- secret/auth/RLS/billing changes;
- deployment credential changes;
- audit/rollback control changes;
- unrestricted production deployment;
- policy self-modification.

## Fail-closed defaults in this repository

Current baseline is intentionally fail-closed:

- `DeniedSandboxAdapter` blocks writes when no secure execution backend is configured.
- `DeniedCanaryAdapter` refuses canary/promotion until immutable deployment integration exists.
- Missing required evaluation gates are marked `unavailable` and block promotion.
- Budget overruns stop runs and preserve the last known good version.
- Audit metadata is append-only and redacted before storage.

## State machine

Evolution runs move through explicit stages:

`observe -> learn -> propose -> write -> test -> evaluate -> canary -> promote/rollback`

Each run tracks immutable IDs, timestamps, policy decisions, gate results, audit event IDs, and last-known-good fallback.

## Admin observability

Admin diagnostics expose non-secret status fields only:

- current version;
- run state and stage;
- candidate/snapshot identity;
- gate summary counts;
- canary/rollback status;
- budget usage summary;
- recent audit event counts.

## Required infrastructure before enabling automatic canary/promotion

Automatic canary/promotion must remain disabled until all are in place:

1. Isolated secure execution runner for sandbox writes/tests.
2. Protected deployment environment with immutable credentials and approvals.
3. External rollback controller not writable by Daemon.
4. Enforced budget/quota controls at infrastructure and provider layers.
5. Append-only central audit sink with retention and access controls.
6. Secret management outside repo/browser/localStorage (e.g., Supabase/GitHub environments).

Until these exist, this foundation remains **safe-by-default and non-promoting**.
