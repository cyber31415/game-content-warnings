#!/usr/bin/env bash
# Creates the project-local virtual environment in .venv/ containing:
#   - a Python venv (for helper tooling)
#   - a private Node.js LTS install (node, npm, npx)
#
# The project lives on a CIFS share that does not support symlinks, so:
#   - Python's venv is created with --copies and a pre-made lib64 directory
#     (venv otherwise tries to symlink lib64 -> lib and fails).
#   - Node's tarball symlinks (bin/npm, bin/npx, bin/corepack) are skipped and
#     replaced with small wrapper scripts.
#   - npm is configured with bin-links=false (see .npmrc), so npm scripts call
#     tools via `node node_modules/<pkg>/...` instead of node_modules/.bin.
#
# Usage:  bash scripts/bootstrap-venv.sh      (idempotent; re-run to repair)
#         source .venv/bin/activate.fish     (fish)  /  source .venv/bin/activate (bash)
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "==> Creating Python venv in $VENV"
  mkdir -p "$VENV/lib64"
  python3 -m venv --copies "$VENV"
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported arch $(uname -m)"; exit 1 ;;
esac

NODE_DIR="$VENV/node"
if [[ ! -x "$NODE_DIR/bin/node" ]] || [[ "$("$NODE_DIR/bin/node" --version)" != "$NODE_VERSION" ]]; then
  echo "==> Installing Node.js $NODE_VERSION into $NODE_DIR"
  TARBALL="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$TMP/$TARBALL"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  # Extract on local tmp first, then copy dereferencing nothing: symlinks are dropped.
  tar -xJf "$TMP/$TARBALL" -C "$TMP"
  (cd "$TMP/node-$NODE_VERSION-linux-$NODE_ARCH" && find . -type l -delete && cp -r . "$NODE_DIR/")
fi

echo "==> Writing wrappers in $VENV/bin"
cat > "$VENV/bin/node" <<EOF
#!/usr/bin/env bash
exec "$NODE_DIR/bin/node" "\$@"
EOF
cat > "$VENV/bin/npm" <<EOF
#!/usr/bin/env bash
exec "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" "\$@"
EOF
cat > "$VENV/bin/npx" <<EOF
#!/usr/bin/env bash
exec "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/bin/npx-cli.js" "\$@"
EOF
chmod +x "$VENV/bin/node" "$VENV/bin/npm" "$VENV/bin/npx"

# Keep npm's global prefix and cache inside the venv too.
mkdir -p "$NODE_DIR/etc"
cat > "$NODE_DIR/etc/npmrc" <<EOF
prefix=$NODE_DIR
cache=$VENV/npm-cache
EOF

# Twitch CLI: mock Helix API, EventSub event simulator, token helper.
TWITCH_CLI_VERSION="${TWITCH_CLI_VERSION:-1.1.24}"
if [[ ! -x "$VENV/bin/twitch-cli" ]] || ! "$VENV/bin/twitch-cli" version 2>/dev/null | grep -q "$TWITCH_CLI_VERSION"; then
  echo "==> Installing Twitch CLI $TWITCH_CLI_VERSION"
  case "$NODE_ARCH" in x64) TC_ARCH=x86_64 ;; arm64) TC_ARCH=arm64 ;; esac
  TC_TAR="twitch-cli_${TWITCH_CLI_VERSION}_Linux_${TC_ARCH}.tar.gz"
  TC_TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/twitchdev/twitch-cli/releases/download/v$TWITCH_CLI_VERSION/$TC_TAR" -o "$TC_TMP/$TC_TAR"
  curl -fsSL "https://github.com/twitchdev/twitch-cli/releases/download/v$TWITCH_CLI_VERSION/checksums.txt" -o "$TC_TMP/checksums.txt"
  (cd "$TC_TMP" && grep " $TC_TAR\$" checksums.txt | sha256sum -c -)
  tar -xzf "$TC_TMP/$TC_TAR" -C "$TC_TMP"
  cp "$(find "$TC_TMP" -type f -name twitch | head -1)" "$VENV/bin/twitch-cli"
  chmod +x "$VENV/bin/twitch-cli"
  rm -rf "$TC_TMP"
fi
# The CLI keeps a SQLite event cache / mock DB in its config dir. SQLite can't lock
# files on the CIFS share, so point its config dir at local disk rather than the
# share (and away from ~/.config, isolating it from any other twitch-cli setup).
TWITCH_CLI_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/twitch-content-warnings"
cat > "$VENV/bin/twitch" <<EOF
#!/usr/bin/env bash
mkdir -p "$TWITCH_CLI_STATE"
XDG_CONFIG_HOME="$TWITCH_CLI_STATE" exec "$VENV/bin/twitch-cli" "\$@"
EOF
chmod +x "$VENV/bin/twitch"

# GitHub CLI (publishing the repo). Only the binary lives in the venv: its login token
# stays in your system keyring / ~/.config/gh on local disk, not on the network share.
GH_VERSION="${GH_VERSION:-2.102.0}"
if [[ ! -x "$VENV/bin/gh" ]] || ! "$VENV/bin/gh" --version 2>/dev/null | grep -q "$GH_VERSION"; then
  echo "==> Installing GitHub CLI $GH_VERSION"
  case "$NODE_ARCH" in x64) GH_ARCH=amd64 ;; arm64) GH_ARCH=arm64 ;; esac
  GH_TAR="gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
  GH_TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_VERSION/$GH_TAR" -o "$GH_TMP/$GH_TAR"
  curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_checksums.txt" -o "$GH_TMP/checksums.txt"
  (cd "$GH_TMP" && grep " $GH_TAR\$" checksums.txt | sha256sum -c -)
  tar -xzf "$GH_TMP/$GH_TAR" -C "$GH_TMP"
  cp "$GH_TMP/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" "$VENV/bin/gh"
  chmod +x "$VENV/bin/gh"
  rm -rf "$GH_TMP"
fi

# libSQL server (sqld): a local stand-in for Turso to test the cache mirror against
# (.venv/bin/sqld --http-listen-addr 127.0.0.1:8097 --db-path /tmp/sqld; see .env.example).
SQLD_VERSION="${SQLD_VERSION:-0.24.32}"
if [[ ! -x "$VENV/bin/sqld" ]] || ! "$VENV/bin/sqld" --version 2>/dev/null | grep -q "$SQLD_VERSION"; then
  echo "==> Installing sqld $SQLD_VERSION"
  case "$NODE_ARCH" in x64) SQ_ARCH=x86_64 ;; arm64) SQ_ARCH=aarch64 ;; esac
  SQ_TAR="libsql-server-${SQ_ARCH}-unknown-linux-gnu.tar.xz"
  SQ_URL="https://github.com/tursodatabase/libsql/releases/download/libsql-server-v$SQLD_VERSION/$SQ_TAR"
  SQ_TMP="$(mktemp -d)"
  curl -fsSL "$SQ_URL" -o "$SQ_TMP/$SQ_TAR"
  curl -fsSL "$SQ_URL.sha256" -o "$SQ_TMP/$SQ_TAR.sha256"
  (cd "$SQ_TMP" && echo "$(cut -d' ' -f1 "$SQ_TAR.sha256")  $SQ_TAR" | sha256sum -c -)
  tar -xJf "$SQ_TMP/$SQ_TAR" -C "$SQ_TMP"
  cp "$(find "$SQ_TMP" -type f -name sqld | head -1)" "$VENV/bin/sqld"
  chmod +x "$VENV/bin/sqld"
  rm -rf "$SQ_TMP"
fi

# Turso CLI (optional: inspect the hosted database). Config kept in local state like the Twitch CLI.
TURSO_CLI_VERSION="${TURSO_CLI_VERSION:-1.0.34}"
if [[ ! -x "$VENV/bin/turso-cli" ]] || ! "$VENV/bin/turso-cli" --version 2>/dev/null | grep -q "$TURSO_CLI_VERSION"; then
  echo "==> Installing Turso CLI $TURSO_CLI_VERSION"
  case "$NODE_ARCH" in x64) TU_ARCH=x86_64 ;; arm64) TU_ARCH=arm64 ;; esac
  TU_TAR="turso-cli_Linux_${TU_ARCH}.tar.gz"
  TU_TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/tursodatabase/turso-cli/releases/download/v$TURSO_CLI_VERSION/$TU_TAR" -o "$TU_TMP/$TU_TAR"
  curl -fsSL "https://github.com/tursodatabase/turso-cli/releases/download/v$TURSO_CLI_VERSION/checksums.txt" -o "$TU_TMP/checksums.txt"
  (cd "$TU_TMP" && grep " $TU_TAR\$" checksums.txt | sha256sum -c -)
  tar -xzf "$TU_TMP/$TU_TAR" -C "$TU_TMP"
  cp "$(find "$TU_TMP" -type f -name turso | head -1)" "$VENV/bin/turso-cli"
  chmod +x "$VENV/bin/turso-cli"
  rm -rf "$TU_TMP"
fi
cat > "$VENV/bin/turso" <<EOF
#!/usr/bin/env bash
mkdir -p "$TWITCH_CLI_STATE/turso"
XDG_CONFIG_HOME="$TWITCH_CLI_STATE/turso" exec "$VENV/bin/turso-cli" "\$@"
EOF
chmod +x "$VENV/bin/turso"

# Python dev tooling (Playwright for local end-to-end/screenshot checks) with its
# browser kept inside the venv rather than ~/.cache.
echo "==> Installing Python dev tools"
"$VENV/bin/python" -m pip install -q -r "$ROOT/scripts/requirements-dev.txt"
PLAYWRIGHT_BROWSERS_PATH="$VENV/ms-playwright" "$VENV/bin/python" -m playwright install --only-shell chromium

# Make activation point tools at the venv-local state.
if ! grep -q PLAYWRIGHT_BROWSERS_PATH "$VENV/bin/activate"; then
  echo "export PLAYWRIGHT_BROWSERS_PATH=\"$VENV/ms-playwright\"" >> "$VENV/bin/activate"
  echo "set -gx PLAYWRIGHT_BROWSERS_PATH \"$VENV/ms-playwright\"" >> "$VENV/bin/activate.fish"
fi

echo "==> Done"
"$VENV/bin/node" --version
"$VENV/bin/npm" --version
