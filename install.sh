#!/bin/sh
set -eu

REPO="tawachdev/cli-agent"
BIN="agent"
INSTALL_DIR="${AGENT_INSTALL_DIR:-$HOME/.local/bin}"

os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "" ;;
  esac
}

arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *) echo "" ;;
  esac
}

OS="$(os)"
ARCH="$(arch)"
if [ -z "$OS" ] || [ -z "$ARCH" ]; then
  echo "unsupported platform: $(uname -s) $(uname -m) — macOS and Linux on arm64/x64 are supported"
  exit 1
fi

ASSET="agent-$OS-$ARCH"
URL_BASE="https://github.com/$REPO/releases/latest/download"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "downloading $ASSET ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL_BASE/$ASSET" -o "$TMP_DIR/$ASSET"
  curl -fsSL "$URL_BASE/$ASSET.sha256" -o "$TMP_DIR/$ASSET.sha256"
else
  wget -q "$URL_BASE/$ASSET" -O "$TMP_DIR/$ASSET"
  wget -q "$URL_BASE/$ASSET.sha256" -O "$TMP_DIR/$ASSET.sha256"
fi

if [ ! -f "$TMP_DIR/$ASSET.sha256" ]; then
  echo "checksum file missing — aborting rather than installing an unverified binary"
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && shasum -a 256 -c "$ASSET.sha256") || { echo "checksum mismatch — aborting"; exit 1; }
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && sha256sum -c "$ASSET.sha256") || { echo "checksum mismatch — aborting"; exit 1; }
else
  echo "no sha256 tool found (shasum or sha256sum) — cannot verify the download, aborting"
  exit 1
fi

chmod +x "$TMP_DIR/$ASSET"
mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/$ASSET" "$INSTALL_DIR/$BIN"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo ""
     echo "note: $INSTALL_DIR is not on your PATH — add it with:"
     echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

echo ""
echo "installed: $INSTALL_DIR/$BIN"
echo "first run: $BIN            (setup wizard opens — bring any API key)"
