#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64; do
  bun build --compile bin/agent.ts --target="$target" --outfile "dist/agent-${target#bun-}"
done

for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  cp "dist/agent-$plat" "npm/platforms/$plat/bin/mimon"
  (cd "npm/platforms/$plat" && npm publish --access public)
done

(cd npm/main && npm publish --access public)
echo "published: npx mimon works"
