#!/bin/bash
# setup.sh — Interactive setup wizard for pi-signal (Docker mode)
# Usage: bash scripts/setup.sh
# Creates and links the bbernhard/signal-cli-rest-api container ("signal-api")
# that the pi extension talks to over REST + WebSocket.
#
# This script needs a real terminal (interactive prompts + a blocking phone
# QR scan), which is why /signal-setup in pi points you here instead of
# running it for you.

set -euo pipefail

CONTAINER_NAME="signal-api"
IMAGE="bbernhard/signal-cli-rest-api"
HOST_PORT=8090
CONTAINER_PORT=8080
VOLUME_NAME="signal-api-data"
DAEMON_URL="http://127.0.0.1:${HOST_PORT}"

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

log_info() { echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $1"; }
log_ok() { echo -e "${COLOR_GREEN}[OK]${COLOR_RESET}   $1"; }
log_warn() { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $1"; }
log_error() { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $1"; }

# ─── Step 1: Find a container runtime ─────────────────────────────────
log_info "Step 1/6: Checking for a container runtime (docker or podman)..."
if command -v docker >/dev/null 2>&1; then
	RUNTIME="docker"
elif command -v podman >/dev/null 2>&1; then
	RUNTIME="podman"
else
	log_error "Neither docker nor podman is installed."
	echo ""
	echo "  Install Docker: https://docs.docker.com/get-docker/"
	echo "  (or Podman: https://podman.io/getting-started/installation/)"
	echo ""
	exit 1
fi
if ! $RUNTIME info >/dev/null 2>&1; then
	log_error "The $RUNTIME daemon is not running (or you lack permission)."
	log_info "Start it (e.g. 'systemctl start docker' or launch Docker Desktop) and re-run."
	exit 1
fi
log_ok "Using runtime: $RUNTIME"

# ─── Step 2: Signal number ────────────────────────────────────────────
echo ""
log_info "Step 2/6: Signal account number"
read -r -p "  Enter the Signal number pi should use (E.164, e.g. +1234567890): " ACCOUNT
ACCOUNT_CLEAN="${ACCOUNT//[-(). ]/}"
if ! [[ "$ACCOUNT_CLEAN" =~ ^\+[1-9][0-9]{1,14}$ ]]; then
	log_error "Invalid E.164 number: '$ACCOUNT'. Expected format: +1234567890"
	exit 1
fi
log_ok "Account: $ACCOUNT_CLEAN"

# ─── Step 3: Existing container? ──────────────────────────────────────
echo ""
log_info "Step 3/6: Checking for an existing '$CONTAINER_NAME' container..."
existing="$($RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -x "$CONTAINER_NAME" || true)"
if [[ -n "$existing" ]]; then
	echo ""
	log_warn "Container '$CONTAINER_NAME' already exists."
	read -r -p "  Recreate it? Existing link state survives in the '$VOLUME_NAME' volume. [y/N]: " recreate
	if [[ "$recreate" =~ ^[Yy]$ ]]; then
		$RUNTIME stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
		$RUNTIME rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
		log_ok "Removed old container (volume kept)."
	else
		log_info "Keeping existing container."
	fi
fi

# ─── Step 4: Port check + create container ────────────────────────────
echo ""
log_info "Step 4/6: Checking port ${HOST_PORT} and creating the container..."
port_busy=0
if command -v lsof >/dev/null 2>&1; then
	lsof -tiTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1 && port_busy=1
fi
if [[ "$port_busy" -eq 1 ]]; then
	log_error "Port ${HOST_PORT} on 127.0.0.1 is already in use."
	log_info "Stop whatever is using it, or choose another port and set PI_SIGNAL_DAEMON_URL accordingly."
	exit 1
fi
log_ok "Port ${HOST_PORT} is free"

$RUNTIME volume inspect "$VOLUME_NAME" >/dev/null 2>&1 || $RUNTIME volume create "$VOLUME_NAME" >/dev/null
log_ok "Volume '$VOLUME_NAME' ready"

$RUNTIME run -d \
	--name "$CONTAINER_NAME" \
	--restart unless-stopped \
	-p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}" \
	-v "${VOLUME_NAME}:/root/.local/share/signal-cli" \
	"$IMAGE" >/dev/null
log_ok "Container '$CONTAINER_NAME' started (bound to 127.0.0.1:${HOST_PORT} only)"

# ─── Step 5: Link the Signal account (QR scan) ────────────────────────
echo ""
log_info "Step 5/6: Linking your Signal account..."
if [[ ! -t 0 ]]; then
	log_error "This script needs an interactive terminal for the QR scan — run it from a real terminal."
	exit 1
fi
echo ""
echo "  The next command opens a QR code. In the Signal app on your phone:"
echo "  Settings → Linked Devices → Link New Device → scan the code."
echo ""
read -r -p "  Press Enter when ready (or 's' to skip if already linked): " ready
if [[ "$ready" =~ ^[Ss]$ ]]; then
	log_warn "Skipping device link."
else
	if ! $RUNTIME exec -it "$CONTAINER_NAME" signal-cli -a "$ACCOUNT_CLEAN" link; then
		log_warn "Link command failed — the account may already be linked, or the scan was cancelled."
		log_info "If it's already linked, you can ignore this and continue."
	fi
fi

# ─── Step 6: Verify + print configuration ─────────────────────────────
echo ""
log_info "Step 6/6: Verifying the REST API..."
ok=""
for _ in $(seq 1 30); do
	if about="$(curl -sf --max-time 3 "${DAEMON_URL}/v1/about" 2>/dev/null)"; then
		ok="$about"
		break
	fi
	sleep 2
done
if [[ -n "$ok" ]]; then
	log_ok "REST API is up: $(echo "$ok" | head -c 120)"
else
	log_error "REST API not reachable at ${DAEMON_URL}/v1/about"
	log_info "Check container logs: $RUNTIME logs --tail 50 $CONTAINER_NAME"
	exit 1
fi

echo ""
echo "  ═══════════════════════════════════════════════════════════════"
echo "  Setup complete. Add these to your shell config"
echo "  (~/.bashrc, ~/.zshrc, ~/.profile), then restart your shell:"
echo ""
echo "    export PI_SIGNAL_ACCOUNT=${ACCOUNT_CLEAN}   # your Signal number (E.164)"
echo "    export PI_SIGNAL_PRIMARY=true               # marks this instance as handling Signal"
echo ""
echo "  Optional — allow other numbers to send/receive with the agent"
echo "  (default: only your own number is allowed):"
echo ""
echo "    export PI_SIGNAL_ALLOWLIST=+15551234567,+441234567890"
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  Then start pi (or run /reload if already running) and verify:"
echo "    /signal-setup    — checks the REST API container is reachable"
echo "    /signal-status   — shows REST API health + WebSocket state"
echo ""
echo "  Send a Note-to-Self message from your phone to test it."
echo ""
log_ok "Done."
