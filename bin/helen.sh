#!/bin/bash
# HELEN CLI Runner Script
# Runs HELEN from any working directory by resolving the repo root from the
# script location rather than the caller's current directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Validate required executables.
for exe in node npm npx; do
  if ! command -v "$exe" &>/dev/null; then
    echo "❌ '$exe' not found. Please install Node.js (v18+) and npm." >&2
    exit 1
  fi
done

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "Installing dependencies..."
  npm ci --legacy-peer-deps --prefix "$REPO_ROOT"
fi

# Execute the TypeScript CLI, forwarding all arguments.
# Use 'exec' so the child process replaces the shell and its exit code is
# returned directly to the caller (interactive and scripted use both work).
exec npx --prefix "$REPO_ROOT" tsx "$REPO_ROOT/src/cli/helen-cli.ts" "$@"
