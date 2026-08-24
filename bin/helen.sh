#!/bin/bash
# HELEN CLI Runner Script
# Simple bash script to run HELEN from the command line

echo "Starting HELEN Terminal Interface..."
echo ""

cd "$(dirname "$0")"/.. || exit 1

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18 or higher."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm ci --legacy-peer-deps
fi

echo ""
echo "🤖 Welcome to HELEN - Terminal Interface"
echo ""

npx tsx src/cli/helen-cli.ts "$@"
