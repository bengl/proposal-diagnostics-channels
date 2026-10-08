#!/bin/sh
# Regenerates divergence-matrix/results/ for node, bun, and deno.
# Workers results need wrangler: start `npx wrangler dev --port 8791`, then
# curl localhost:8791/ > divergence-matrix/results/workers.json
set -e
cd "$(dirname "$0")/.."

node tests/cli.mjs > divergence-matrix/results/node.json
echo "node done"

bun tests/cli.mjs > divergence-matrix/results/bun.json
echo "bun done"

if command -v deno >/dev/null 2>&1; then
  deno run -A tests/cli.mjs > divergence-matrix/results/deno.json
  echo "deno done"
else
  echo "deno not found, skipped"
fi

echo "workers: npx wrangler --version > divergence-matrix/results/workers-env.txt"
echo "        npx wrangler dev --port 8791 & then curl localhost:8791/ > divergence-matrix/results/workers.json"
