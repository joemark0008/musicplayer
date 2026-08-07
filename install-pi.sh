#!/usr/bin/env bash
#
# Raspberry Pi installer for the remote music server.
#
# Safe to re-run: on a second pass it skips what's already installed and
# just rebuilds and restarts the service.
#
#   ./install-pi.sh                          # interactive
#   ./install-pi.sh --music-dir /mnt/usb/Music --yes
#   ./install-pi.sh --dry-run                # show what it would do
#   ./install-pi.sh --uninstall
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------- options
MUSIC_DIR="${MUSIC_DIR:-$HOME/Music}"
PORT="${PORT:-3000}"
AUDIO_DEVICE="${AUDIO_DEVICE:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
SERVICE_NAME="music-player"
NODE_MAJOR=22
ASSUME_YES=0
DRY_RUN=0
SKIP_DEPS=0
NO_SERVICE=0
UNINSTALL=0

usage() {
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --music-dir PATH     Where your music lives           (default: $HOME/Music)
  --port N             HTTP port                        (default: 3000)
  --audio-device NAME  Force an mpv audio device, e.g. alsa/default
  --auth-token TOKEN   Require a token to use the API
  --skip-deps          Don't touch apt/node/yt-dlp
  --no-service         Install but don't set up systemd
  --uninstall          Remove the service (leaves your music alone)
  -y, --yes            No prompts
  -n, --dry-run        Print commands instead of running them
  -h, --help           This
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --music-dir)    MUSIC_DIR="$2"; shift 2 ;;
    --port)         PORT="$2"; shift 2 ;;
    --audio-device) AUDIO_DEVICE="$2"; shift 2 ;;
    --auth-token)   AUTH_TOKEN="$2"; shift 2 ;;
    --skip-deps)    SKIP_DEPS=1; shift ;;
    --no-service)   NO_SERVICE=1; shift ;;
    --uninstall)    UNINSTALL=1; shift ;;
    -y|--yes)       ASSUME_YES=1; shift ;;
    -n|--dry-run)   DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# ----------------------------------------------------------------- helpers
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
[[ -t 1 ]] || { BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""; }

step()  { echo; echo "${BOLD}${BLUE}==>${RESET} ${BOLD}$*${RESET}"; }
info()  { echo "    $*"; }
ok()    { echo "    ${GREEN}✓${RESET} $*"; }
warn()  { echo "    ${YELLOW}!${RESET} $*"; }
die()   { echo "${RED}Error:${RESET} $*" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    ${DIM}\$ $*${RESET}"
  else
    "$@"
  fi
}

# Same as run(), but the command is a shell string (pipes, redirects).
run_sh() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    ${DIM}\$ $1${RESET}"
  else
    bash -c "$1"
  fi
}

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  read -r -p "    $1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  step "Removing the $SERVICE_NAME service"
  run sudo systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  run sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  run sudo systemctl daemon-reload
  ok "Service removed. Your music, playlists and $SCRIPT_DIR are untouched."
  info "To remove the app itself:  rm -rf $SCRIPT_DIR"
  exit 0
fi

# ------------------------------------------------------------ sanity checks
step "Checking the system"

[[ $EUID -ne 0 ]] || die "Don't run this with sudo. Run it as your normal user; it will ask for sudo when needed."
[[ -f "$SCRIPT_DIR/server/index.js" ]] || die "Run this from inside the music-server folder."
have sudo || die "sudo is required."

ARCH="$(uname -m)"
info "Architecture: $ARCH"
case "$ARCH" in
  aarch64|arm64) ok "64-bit ARM — good" ;;
  armv7l)
    warn "32-bit OS detected. Node may be unavailable for armhf."
    warn "The 64-bit Raspberry Pi OS image is strongly recommended."
    confirm "Continue anyway?" || exit 1
    ;;
  armv6l) die "armv6 (Pi 1 / Zero W) can't run a modern Node. A Pi 3 or newer is needed." ;;
  x86_64) info "Not a Pi, but this will work on any Debian-ish machine." ;;
  *) warn "Unrecognised architecture; continuing." ;;
esac

if [[ -f /proc/device-tree/model ]]; then
  info "Model: $(tr -d '\0' < /proc/device-tree/model)"
fi

have apt-get || die "This installer expects a Debian-based OS (Raspberry Pi OS, Ubuntu, Debian)."

# -------------------------------------------------------------- dependencies
if [[ $SKIP_DEPS -eq 0 ]]; then
  step "Installing system packages"
  info "mpv (playback), ffmpeg (audio extraction), curl, git"
  run sudo apt-get update
  run sudo apt-get install -y --no-install-recommends mpv ffmpeg curl git alsa-utils
  ok "System packages ready"

  step "Checking Node.js"
  NODE_OK=0
  if have node; then
    CURRENT="$(node -v | sed 's/^v//' | cut -d. -f1)"
    info "Found Node v$(node -v | sed 's/^v//')"
    [[ "$CURRENT" -ge 20 ]] && NODE_OK=1
  else
    info "Node is not installed"
  fi

  if [[ $NODE_OK -eq 1 ]]; then
    ok "Node is new enough (need 20+)"
  else
    warn "Installing Node $NODE_MAJOR from NodeSource"
    run_sh "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -"
    run sudo apt-get install -y nodejs
    if [[ $DRY_RUN -eq 0 ]]; then
      have node || die "Node install failed. Is there a package for $ARCH?"
      ok "Installed Node $(node -v)"
    fi
  fi

  step "Installing yt-dlp (for YouTube downloads)"
  if have yt-dlp; then
    ok "yt-dlp already present: $(yt-dlp --version 2>/dev/null || echo unknown)"
  else
    # apt's yt-dlp lags badly and breaks whenever YouTube changes.
    run sudo apt-get install -y pipx
    run pipx install yt-dlp
    run pipx ensurepath
    ok "yt-dlp installed via pipx"
  fi
else
  step "Skipping dependency install (--skip-deps)"
fi

YTDLP_PATH="$(command -v yt-dlp || echo "$HOME/.local/bin/yt-dlp")"

# --------------------------------------------------------------------- audio
step "Checking audio"
if [[ $DRY_RUN -eq 0 ]] && have aplay; then
  if aplay -l 2>/dev/null | grep -q '^card'; then
    aplay -l 2>/dev/null | grep '^card' | sed 's/^/    /'
    ok "Sound card detected"
  else
    warn "No sound card found by ALSA."
    warn "Run 'sudo raspi-config' → System Options → Audio, or plug in a USB DAC."
  fi
fi

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx audio; then
  warn "$USER is not in the 'audio' group — mpv won't be able to open the device."
  if confirm "Add $USER to the audio group?"; then
    run sudo usermod -aG audio "$USER"
    warn "You must log out and back in (or reboot) for this to take effect."
  fi
else
  ok "$USER is in the audio group"
fi

# ------------------------------------------------------------------- library
step "Setting up the music folder"
if [[ ! -d "$MUSIC_DIR" ]]; then
  info "$MUSIC_DIR does not exist"
  confirm "Create it?" || die "Pick another folder with --music-dir"
  run mkdir -p "$MUSIC_DIR"
fi
run mkdir -p "$MUSIC_DIR/Playlists"
ok "Music folder: $MUSIC_DIR"

case "$MUSIC_DIR" in
  /home/*|/root/*)
    warn "This is on the SD card. Downloads and playlists write to it constantly,"
    warn "which wears cards out. A USB drive is a better home: --music-dir /mnt/usb/Music"
    ;;
esac

# ------------------------------------------------------------------- build
step "Installing the app"
cd "$SCRIPT_DIR"
run npm install --omit=dev --no-audit --no-fund
ok "Server dependencies installed"

info "Building the web UI — this takes a few minutes on a Pi, be patient"
# --include=dev explicitly: vite is a devDependency, and it would be skipped
# if NODE_ENV=production happens to be exported in this shell.
run npm --prefix client install --include=dev --no-audit --no-fund
run npm --prefix client run build
[[ $DRY_RUN -eq 1 || -f "$SCRIPT_DIR/client/dist/index.html" ]] \
  || die "UI build produced no output in client/dist"
ok "UI built"

# ------------------------------------------------------------------ service
if [[ $NO_SERVICE -eq 1 ]]; then
  step "Skipping systemd setup (--no-service)"
  echo
  ok "Start it by hand with:"
  info "MUSIC_DIR='$MUSIC_DIR' PORT=$PORT npm start"
  exit 0
fi

step "Creating the systemd service"

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
USER_ID="$(id -u)"

UNIT_CONTENT="[Unit]
Description=Remote Music Server (mpv + Express)
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
Group=audio
WorkingDirectory=${SCRIPT_DIR}

Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
Environment=MUSIC_DIR=${MUSIC_DIR}
Environment=CONFIG_PATH=${SCRIPT_DIR}/config.json
Environment=YTDLP_BINARY=${YTDLP_PATH}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${HOME}/.local/bin
# Needed for PipeWire/PulseAudio to be reachable from a service.
Environment=XDG_RUNTIME_DIR=/run/user/${USER_ID}"

[[ -n "$AUDIO_DEVICE" ]] && UNIT_CONTENT+="
Environment=AUDIO_DEVICE=${AUDIO_DEVICE}"
[[ -n "$AUTH_TOKEN" ]] && UNIT_CONTENT+="
Environment=AUTH_TOKEN=${AUTH_TOKEN}"

UNIT_CONTENT+="

ExecStart=${NODE_BIN} server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "    ${DIM}would write $UNIT_PATH:${RESET}"
  echo "$UNIT_CONTENT" | sed 's/^/    | /'
else
  echo "$UNIT_CONTENT" | sudo tee "$UNIT_PATH" >/dev/null
  ok "Wrote $UNIT_PATH"
fi

run sudo systemctl daemon-reload
run sudo systemctl enable "$SERVICE_NAME"
run sudo systemctl restart "$SERVICE_NAME"

# A headless Pi has no login session, so the user's audio server never starts.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  info "Enabling lingering so audio works without anyone logged in"
  run sudo loginctl enable-linger "$USER"
fi

# ------------------------------------------------------------------- report
sleep 2
step "Done"

if [[ $DRY_RUN -eq 0 ]]; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service is running"
  else
    warn "Service isn't running. Logs:"
    sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager | sed 's/^/    /'
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "    ${BOLD}Open it at:${RESET}"
[[ -n "${IP:-}" ]] && echo "      http://${IP}:${PORT}"
echo "      http://$(hostname).local:${PORT}"
echo
echo "    ${BOLD}Useful commands:${RESET}"
echo "      sudo systemctl status ${SERVICE_NAME}"
echo "      journalctl -u ${SERVICE_NAME} -f"
echo "      sudo systemctl restart ${SERVICE_NAME}"
echo
echo "    Put music in ${MUSIC_DIR} and press Rescan in the web UI."
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx audio; then
  echo
  warn "Reboot before expecting sound — the audio group change needs it."
fi
