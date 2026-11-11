#!/bin/sh
# Agent Office connector installer.
#
#   curl -fsSL https://<your-office>/install.sh | sh
#
# Downloads the connector binary for this Mac from the latest GitHub release, asks for the
# server URL, shared password, display name, an optional look description and a machine
# label, writes
# ~/.config/agent-office/config.toml and registers a launchd agent so it runs at login.
#
# Non-interactive:  AO_SERVER=... AO_PASSWORD=... AO_NAME=... [AO_DESCRIPTION=...] [AO_MACHINE=...] sh install.sh
# Other overrides:  AGENT_OFFICE_UPDATE_BASE (download base URL), AGENT_OFFICE_INSTALL_DIR
#                   (default ~/.local/bin), AO_NONINTERACTIVE=1 (never prompt).
set -eu

# The server serving this script replaces one of these placeholders with its own origin.
DEFAULT_SERVER="__AGENT_OFFICE_SERVER__"
case "$DEFAULT_SERVER" in
  __*) DEFAULT_SERVER="__SERVER_URL__" ;;
esac
case "$DEFAULT_SERVER" in
  __*) DEFAULT_SERVER="" ;;
esac

BASE="${AGENT_OFFICE_UPDATE_BASE:-https://github.com/MrGatzi/agent-camp/releases/latest/download}"
INSTALL_DIR="${AGENT_OFFICE_INSTALL_DIR:-$HOME/.local/bin}"
BIN="$INSTALL_DIR/agent-office"

say() { printf '%s\n' "$*"; }
# show paths under $HOME as ~/...
pretty() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}
die() {
  printf 'agent-office install: %s\n' "$*" >&2
  exit 1
}

# ---- platform -----------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) os=darwin ;;
  Linux)
    os=linux
    say "warning: Linux is only supported for testing (no launchd service will be installed)."
    ;;
  *) die "unsupported OS: $OS (Agent Office supports macOS)" ;;
esac
case "$ARCH" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64)
    arch=x64
    # a shell running under Rosetta on Apple Silicon reports x86_64
    if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
      arch=arm64
    fi
    ;;
  *) die "unsupported CPU architecture: $ARCH" ;;
esac
if [ "$os" = linux ] && [ "$arch" != x64 ]; then
  die "no Linux build for $ARCH (only linux-x64 is built, for tests)"
fi
ASSET="agent-office-$os-$arch"

command -v curl >/dev/null 2>&1 || die "curl is required"

# ---- download -----------------------------------------------------------------------------
say "Agent Office connector installer"
say "  downloading $ASSET from $BASE"
mkdir -p "$INSTALL_DIR"
TMP="$INSTALL_DIR/.agent-office.download.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
curl -fsSL "$BASE/$ASSET" -o "$TMP" || die "download failed: $BASE/$ASSET"
chmod 755 "$TMP"
VERSION="$("$TMP" version 2>/dev/null)" || die "the downloaded binary does not run on this machine"
mv -f "$TMP" "$BIN"
trap - EXIT INT TERM
say "  installed agent-office $VERSION to $(pretty "$BIN")"

# ---- questions (stdin is the curl pipe, so prompts read from /dev/tty) ----------------------
TTY=""
if [ -z "${AO_NONINTERACTIVE:-}" ] && (exec 3</dev/tty) 2>/dev/null; then
  TTY=/dev/tty
fi

# ask PROMPT DEFAULT [secret]  -> prints the answer (or DEFAULT when empty / no terminal)
ask() {
  if [ -z "$TTY" ]; then
    printf '%s' "$2"
    return 0
  fi
  if [ -n "$2" ] && [ "${3:-}" != secret ]; then
    printf '%s [%s]: ' "$1" "$2" >"$TTY"
  else
    printf '%s: ' "$1" >"$TTY"
  fi
  if [ "${3:-}" = secret ]; then stty -echo <"$TTY" 2>/dev/null || true; fi
  ans=""
  IFS= read -r ans <"$TTY" || ans=""
  if [ "${3:-}" = secret ]; then
    stty echo <"$TTY" 2>/dev/null || true
    printf '\n' >"$TTY"
  fi
  [ -n "$ans" ] || ans="$2"
  printf '%s' "$ans"
}

existing() { "$BIN" configure --get "$1" 2>/dev/null || true; }

[ -n "$TTY" ] && say ""

# server
if [ -n "${AO_SERVER:-}" ]; then
  SERVER="$AO_SERVER"
else
  def="$(existing server)"
  [ -n "$def" ] || def="$DEFAULT_SERVER"
  SERVER="$(ask "Office server URL" "$def")"
fi
[ -n "$SERVER" ] || die "no server URL (set AO_SERVER or run in a terminal)"

# password ("" answer keeps an existing one)
SET_PASSWORD=1
if [ -n "${AO_PASSWORD+x}" ]; then
  PASSWORD="$AO_PASSWORD"
else
  had="$(existing password)"
  if [ -n "$had" ]; then
    PASSWORD="$(ask "Shared password (enter to keep the current one)" "" secret)"
    [ -n "$PASSWORD" ] || SET_PASSWORD=0
  else
    PASSWORD="$(ask "Shared password" "" secret)"
    [ -n "$PASSWORD" ] || die "no password (set AO_PASSWORD or run in a terminal)"
  fi
fi

# display name
if [ -n "${AO_NAME:-}" ]; then
  NAME="$AO_NAME"
else
  def="$(existing name)"
  if [ -z "$def" ] && [ "$os" = darwin ]; then def="$(id -F 2>/dev/null || true)"; fi
  [ -n "$def" ] || def="${USER:-}"
  NAME="$(ask "Your display name" "$def")"
fi
[ -n "$NAME" ] || die "no display name (set AO_NAME or run in a terminal)"

# optional look description for the avatar
if [ -n "${AO_DESCRIPTION+x}" ]; then
  DESCRIPTION="$AO_DESCRIPTION"
else
  DESCRIPTION="$(ask "Describe your look in one line (optional, e.g. curly hair, round glasses)" "$(existing self_description)")"
fi

# machine label on the agent card (same name on every machine = one person; this tells them apart)
if [ -n "${AO_MACHINE+x}" ]; then
  MACHINE="$AO_MACHINE"
else
  def="$(existing machine_name)"
  [ -n "$def" ] || def="$(hostname 2>/dev/null | cut -d. -f1)"
  MACHINE="$(ask "Name of this machine (shown on your agent cards)" "$def")"
fi

# ---- configure (agent-office writes the TOML itself, so no quoting bugs here) --------------
set -- configure --server "$SERVER" --name "$NAME" --description "$DESCRIPTION" --machine-name "$MACHINE"
if [ "$SET_PASSWORD" = 1 ]; then set -- "$@" --password "$PASSWORD"; fi
"$BIN" "$@" >/dev/null || die "could not write the config"
say "  config written to ~/.config/agent-office/config.toml"

# ---- service ------------------------------------------------------------------------------
if [ "$os" = darwin ]; then
  "$BIN" install-service || die "could not register the launchd agent"
  sleep 3 # give it a moment to connect
else
  say "  (Linux: no service installed; start it with: $(pretty "$BIN") run)"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "  note: $(pretty "$INSTALL_DIR") is not on your PATH; add it, or run $(pretty "$BIN") directly." ;;
esac

say ""
"$BIN" status || true
say ""
say "Done. Useful commands: agent-office status | agent-office logs | agent-office uninstall"
