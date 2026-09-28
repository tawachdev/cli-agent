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
  curl -fsSL "$URL_BASE/$ASSET" -o "$TMP_DIR/$BIN"
  curl -fsSL "$URL_BASE/$ASSET.sha256" -o "$TMP_DIR/$BIN.sha256" || true
else
  wget -q "$URL_BASE/$ASSET" -O "$TMP_DIR/$BIN"
  wget -q "$URL_BASE/$ASSET.sha256" -O "$TMP_DIR/$BIN.sha256" || true
fi

if [ -f "$TMP_DIR/$BIN.sha256" ]; then
  if command -v shasum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && shasum -a 256 -c "$BIN.sha256") || { echo "checksum mismatch — aborting"; exit 1; }
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && sha256sum -c "$BIN.sha256") || { echo "checksum mismatch — aborting"; exit 1; }
  fi
fi

chmod +x "$TMP_DIR/$BIN"
mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/$BIN" "$INSTALL_DIR/$BIN"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo ""
     echo "note: $INSTALL_DIR is not on your PATH — add it with:"
     echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

echo ""
echo "installed: $INSTALL_DIR/$BIN"
echo "first run: $BIN            (setup wizard opens — bring any API key)"
echo "local ai:  ollama pull qwen2.5-coder:14b   (optional, no key needed)"
