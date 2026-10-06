#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

root_version="$(node -e "console.log(require('./package.json').version)")"
for manifest in npm/main/package.json npm/platforms/darwin-arm64/package.json npm/platforms/darwin-x64/package.json npm/platforms/linux-arm64/package.json npm/platforms/linux-x64/package.json; do
  manifest_version="$(node -e "console.log(require('./$manifest').version)")"
  if [ "$manifest_version" != "$root_version" ]; then
    echo "version mismatch: $manifest is $manifest_version, root is $root_version — sync versions before publishing"
    exit 1
  fi
done

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
echo "published: npx mimon works"
