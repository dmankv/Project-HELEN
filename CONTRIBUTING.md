# Contributing to Project HELEN

This repository enforces branch-diagnostic safeguards through CI and required GitHub settings on `main`.

## Maintainer-only GitHub settings for `main`

Configure these in **Settings → Branches/Rules** and **Settings → General**:

1. Require pull requests before merge.
2. Require required status checks to pass before merge (including CI workflows that run `check:imports` and `test:adaptive`).
3. Require at least 1 approving review.
4. Enable automatic deletion of head branches after merge.

## CI-enforced safeguards

`npm run check:imports` runs on pull requests and deployments and enforces:

- **Migration filename/timestamp guard** (`supabase/migrations/*.sql`)
  - Filenames must follow `YYYYMMDDHHmmss_description.sql`.
  - The 14-digit prefix must be a real UTC timestamp.
  - Migration versions must be unique.
  - For PRs, newly added migration versions must be strictly newer than the merge-base max version, and existing migrations cannot be renamed/deleted.
- **Legacy prefixed ID ban in frontend source**
  - Rejects executable construction patterns such as `` `daemon-${...}` ``, `` `mem-${...}` ``, `` `interaction-${...}` ``, and `'mem-' + value` in `src/**/*.{ts,tsx}`.
  - `src/services/daemonStorageMigration.ts` is excluded because it intentionally handles legacy migration cleanup.
- **Frontend provider-key literal ban**
  - Rejects `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` literals inside `src/`.
  - Server-side/Supabase secret handling outside `src/` remains allowed.

`npm run test:adaptive` runs deterministic adaptive-intelligence fixtures (20 assertions) for:

- strategy selection
- preference precedence
- distress-mood safety overrides
- memory retrieval bounds
- capability routing

## Local validation before opening a PR

Run at minimum:

```bash
npm run check:imports
npm run test:adaptive
npm run test:unit
```

If you add a migration, use a UTC timestamp strictly newer than the current max migration version (`20260825090000` at time of writing).

Example valid migration name:

```text
20260826000000_add_example_table.sql
```
