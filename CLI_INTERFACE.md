# Daemon CLI Interface

## Run CLI

```bash
npm run cli
```

Wrapper alternatives:

```bash
./bin/daemon.sh
python3 bin/daemon-cli.py
```

Both wrappers resolve the repository root from their own location, so they
work from any caller working directory.

One-shot non-interactive mode:

```bash
npm run cli -- --message "hello"
echo "hello" | npm run cli
```

## Available commands

- `help`
- `stats`
- `clear`
- `exit` / `quit`
- `remember this: <text>`
- `what do you remember?`
- `feedback: <helpful|neutral|unhelpful> [optional note]`
- `analytics`
- `export [all|learning|memories]`

## Scope

The CLI is a local terminal interface that uses `src/services/daemonResponseBrain.ts`.
It is separate from the deployed GitHub Pages frontend and does not use browser-only modules.

## Memory

CLI memories are **process-local** and are discarded when the CLI exits.
They are not shared with the browser application (which uses browser `localStorage`).

## Feedback, analytics, and export

These commands apply to the current CLI process only:

- `feedback: helpful`, `feedback: neutral`, or `feedback: unhelpful` rates the
  latest unrated response. An optional note is stored with that rating.
- `analytics` reports interaction counts, feedback totals, helpfulness rate,
  intents, and uptime without printing message content.
- `export` writes a JSON snapshot of the current session to standard output.
  Use `export learning` or `export memories` for a narrower snapshot; `export`
  and `export all` include both.

For a clean JSON file, invoke the TypeScript entrypoint directly:

```bash
npx tsx src/cli/daemon-cli.ts --message export > daemon-session.json
```

Piped multi-line input executes each non-empty line as a separate command in
the same CLI session, so feedback can follow a response:

```bash
printf 'hello\nfeedback: helpful\nanalytics\n' | npm run cli
```

## Smoke test

```bash
npm run cli:smoke
```

Verifies non-interactive invocations: `--message`, stdin, empty stdin, unknown flag
rejection, and both wrappers from a non-root working directory.

## Argument validation

The CLI validates the entire argument list before running.  Any of the
following produces a nonzero exit with a clear error message:

| Case | Example | Error |
|---|---|---|
| Unknown long flag | `--bogus-flag` | `Unknown option: --bogus-flag` |
| Unknown short flag | `-x` | `Unknown option: -x` |
| Trailing flag after value | `--message hi --bogus` | `Unknown option: --bogus` |
| Duplicate `--message`/`-m` | `--message a --message b` | `Duplicate option: --message` |
| Missing value for `--message` | `--message` (no word follows) | `Missing value for --message/-m.` |
| Unexpected positional arg | `npm run cli -- foo` | `Unexpected argument: foo` |

`--help` / `-h` always exits 0 and prints usage.

Unsupported flags produce a nonzero exit and an error message.
