#!/usr/bin/env bash
# deploy/install-service.sh — install grimoire as a systemd service
# Must be run from the grimoire engine root, or any location (it resolves paths).
# Will re-exec itself with sudo if not already root.

set -euo pipefail

# ── Re-exec as root if needed ─────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "grimoire: root required to install systemd service — re-running with sudo..."
  exec sudo --preserve-env=HOME,USER,PATH "$0" "$@"
fi

# ── Resolve paths ─────────────────────────────────────────────────────────────
# SUDO_USER is set when we got here via sudo; fall back to USER
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)

# Engine root is the directory containing this script's parent (deploy/../)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ENGINE_ROOT/.env"

# Find node — prefer the user's nvm node, fall back to system node
NODE_BIN=$(sudo -u "$TARGET_USER" bash -lc 'which node 2>/dev/null' || which node 2>/dev/null || true)

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found — install Node.js 18+ first"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — copy .env.example to .env and configure it first"
  exit 1
fi

SERVICE_FILE=/etc/systemd/system/grimoire.service

# ── Write service unit ────────────────────────────────────────────────────────
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Grimoire Knowledge Graph Server
Documentation=https://github.com/vgvm-lbl/grimoire
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$ENGINE_ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN bin/grim-server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=grimoire

[Install]
WantedBy=multi-user.target
EOF

echo "grimoire: wrote $SERVICE_FILE"

# ── Enable and start ──────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable grimoire
systemctl restart grimoire

echo ""
systemctl status grimoire --no-pager -l
echo ""
echo "grimoire: service installed and running"
echo "  logs:   journalctl -u grimoire -f"
echo "  health: curl http://aid:3666/health"
