# HELEN CLI Interface

## Run CLI

```bash
npm run cli
```

Wrapper alternatives:

```bash
./bin/helen.sh
python3 bin/helen-cli.py
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

## Scope

The CLI is a local terminal interface that uses `src/services/helenResponseBrain.ts`.
It is separate from the deployed GitHub Pages frontend and does not use browser-only modules.

## Memory

CLI memories are **process-local** and are discarded when the CLI exits.
They are not shared with the browser application (which uses browser `localStorage`).

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

## Unsupported commands

`feedback`, `export`, and `analytics` are not implemented.
Unsupported flags produce a nonzero exit and an error message.

