#!/usr/bin/env python3
"""
CLI Wrapper for Daemon Text Interface
Provides a simple command to run the text-based interface.
"""

import subprocess
import sys
import os
import shutil

# Resolve the repository root relative to this script, not the caller's cwd.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def main():
    """Run Daemon CLI interface."""
    # Validate required executables before doing anything.
    for exe in ("node", "npm", "npx"):
        if shutil.which(exe) is None:
            print(f"Error: '{exe}' not found. Please install Node.js (v18+) and npm.", file=sys.stderr)
            sys.exit(1)

    try:
        # Check if node_modules exist under the repo root, not the cwd.
        if not os.path.isdir(os.path.join(REPO_ROOT, "node_modules")):
            print("Dependencies not installed. Running npm ci --legacy-peer-deps...")
            result = subprocess.run(
                ["npm", "ci", "--legacy-peer-deps"],
                cwd=REPO_ROOT,
            )
            if result.returncode != 0:
                sys.exit(result.returncode)

        # Run TypeScript CLI via tsx; forward all caller arguments.
        proc = subprocess.run(
            ["npx", "tsx", "src/cli/daemon-cli.ts", *sys.argv[1:]],
            cwd=REPO_ROOT,
        )
        sys.exit(proc.returncode)

    except KeyboardInterrupt:
        print("\n\nDaemon CLI terminated.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
