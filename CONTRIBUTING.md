# Contributing to Project-HELEN

## Branch and merge policy

### Branch protection — `main` (risk 5a)

`main` is the production branch and powers the GitHub Pages deployment.
**Branch protection must be enabled** in repository settings:

- **Require a pull request** before merging — direct pushes to `main` are
  prohibited.
- **Require status checks to pass** — the `CI / validate` workflow must be
  green before a PR can be merged.
- **Require at least one approval** before merging.

To enable this, go to **Settings → Branches → Add classic branch protection rule**,
set the branch name pattern to `main`, and check the options above.

### Automatic branch deletion on merge (risk 5g)

The project uses Copilot agent branches heavily. Without automatic deletion
these accumulate rapidly and make the repository hard to navigate.

Enable auto-delete in **Settings → General → "Automatically delete head branches"**.

This deletes merged PR branches immediately after merge and has no effect on
`main` or manually-retained branches.

---

## Supabase migration timestamps (risk 5c)

Every new migration file must be placed in `supabase/migrations/` and named
with a strictly ascending 14-digit timestamp prefix in `YYYYMMDDHHmmss` format.

The current highest migration timestamp is **`20260825162000`**
(`20260825162000_github_write_access.sql`).

**Any new migration must use a timestamp greater than `20260825162000`.**

Example:
```
20260825162001_your_migration_name.sql
```

The `check:imports` CI step enforces this automatically and will fail the build
if migration timestamps are not strictly ascending.

---

## ID generation (risk 5d)

All Daemon entity IDs (conversations, messages, memories, learning interactions,
adaptive evidence) must be raw UUID v4 strings.  Always use `genUUID()` from
`src/services/daemonStorageMigration.ts`.

Forbidden patterns (caught by the `check:imports` CI step):
- `` `daemon-${…}` `` or `'daemon-' + …`
- `` `mem-${…}` `` or `'mem-' + …`
- `` `interaction-${…}` `` or `'interaction-' + …`

These legacy forms cannot be stored in the Supabase `uuid` columns and will
cause runtime insertion failures.

---

## Provider secret hygiene (risk 5f)

The frontend (`src/`) must never contain the string literals
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

Provider keys are Supabase Function secrets accessed exclusively inside the
`daemon-chat` Edge Function.  The `check:imports` CI step will fail the build
if either string is found in any `src/**/*.ts` or `src/**/*.tsx` file.

---

## Local development validation

```bash
npm run lint
npm test
npm run test:adaptive
npm run test:unit
npm run test:server
npm run check:dist
npm run check:imports    # also runs migration-order, prefixed-ID, and secret-key checks
npm run cli:smoke
npm run server:typecheck
npm run server:build
```
