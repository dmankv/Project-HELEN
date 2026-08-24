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
