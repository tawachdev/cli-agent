#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64; do
  bun build --compile bin/agent.ts --target="$target" --outfile "dist/agent-${target#bun-}"
done

publish_if_new() {
  local dir="$1" name
  cd "$dir"
  name="$(node -e "console.log(require('./package.json').name)" 2>/dev/null)"
  if [ "$(npm view "$name@$(node -e "console.log(require('./package.json').version)")" version 2>/dev/null)" = "$(node -e "console.log(require('./package.json').version)")" ]; then
    echo "skip $name@$(node -e "console.log(require('./package.json').version)") — already published"
    cd - > /dev/null
    return 0
  fi
  npm publish --access public
  cd - > /dev/null
}

for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  cp "dist/agent-$plat" "npm/platforms/$plat/bin/mimon"
  publish_if_new "$PWD/npm/platforms/$plat"
done

publish_if_new "$PWD/npm/main"
echo "published: npx mimon-cli works"
