#!/usr/bin/env bash
# deploy/setup-client.sh — configure this machine as a Grimoire client
#
# Run after cloning the repo:
#   cd grimoire && ./deploy/setup-client.sh
#
# What it does:
#   1. Checks Node.js 18+
#   2. npm install
#   3. Writes .env (remote mode — points at aid:3663)
#   4. Optionally adds aid to /etc/hosts (asks for IP if missing)
#   5. Symlinks grim CLI into ~/bin (no sudo, no global install)
#   6. Configures Claude Code: MCP server + plugin
#   7. Smoke-tests the connection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✔${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✘${NC}  $*"; exit 1; }
step() { echo -e "\n░ $*"; }

# ── 1. Node.js ────────────────────────────────────────────────────────────────
step "Checking Node.js..."
NODE_BIN=$(which node 2>/dev/null || true)
[[ -z "$NODE_BIN" ]] && fail "Node.js not found — install Node.js 18+ first (https://nodejs.org)"

NODE_MAJOR=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')
[[ "$NODE_MAJOR" -lt 18 ]] && fail "Node.js 18+ required (found v$(node -e 'process.stdout.write(process.version.slice(1))'))"
ok "Node.js $(node --version)"

# ── 2. npm install ────────────────────────────────────────────────────────────
step "Installing dependencies..."
cd "$ENGINE_ROOT"
npm install --silent
ok "npm install done"

# ── 3. Write .env (remote mode) ───────────────────────────────────────────────
step "Configuring .env..."
ENV_FILE="$ENGINE_ROOT/.env"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — skipping (delete it to regenerate)"
else
  cat > "$ENV_FILE" <<'EOF'
# Grimoire client — remote mode
# GRIMOIRE_ROOT is intentionally unset; all KB access goes via the server.

GRIMOIRE_HOST=http://aid:3663
OLLAMA_HOST=http://aid:11434
EOF
  ok "wrote .env (remote mode)"
fi

# ── 4. /etc/hosts — add aid if missing ────────────────────────────────────────
step "Checking /etc/hosts for 'aid'..."
if grep -qE '^\s*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\s+.*\baid\b' /etc/hosts; then
  ok "aid already in /etc/hosts"
else
  warn "aid not found in /etc/hosts"
  echo    "  The Grimoire server runs on a host named 'aid'."
  echo    "  Enter the IP address of aid (leave blank to skip):"
  read -r -p "  aid IP: " AID_IP

  if [[ -n "$AID_IP" ]]; then
    if [[ "$EUID" -ne 0 ]]; then
      echo "  Adding to /etc/hosts (requires sudo)..."
      echo "$AID_IP  aid" | sudo tee -a /etc/hosts > /dev/null
    else
      echo "$AID_IP  aid" >> /etc/hosts
    fi
    ok "added: $AID_IP  aid"
  else
    warn "skipped — add 'aid' to /etc/hosts manually if DNS doesn't resolve it"
  fi
fi

# ── 5. Symlink grim CLI into ~/bin ────────────────────────────────────────────
step "Linking grim CLI into ~/bin..."

install_grim_link() {
  local bin_dir="$HOME/bin"
  local link="$bin_dir/grim"
  local target="$ENGINE_ROOT/bin/grim.js"

  mkdir -p "$bin_dir"
  chmod +x "$target"

  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    ok "~/bin/grim already linked"
    return
  fi

  if [[ -L "$link" || -e "$link" ]]; then
    warn "~/bin/grim already exists ($(readlink "$link" 2>/dev/null || echo 'not a symlink'))"
    read -r -p "  Overwrite it? [y/N] " CONFIRM
    [[ "${CONFIRM,,}" == "y" ]] || { warn "skipped — leaving existing ~/bin/grim in place"; return; }
    rm "$link"
  fi
  ln -s "$target" "$link"
  ok "linked: ~/bin/grim → $target"

  if ! echo ":$PATH:" | grep -q ":$bin_dir:"; then
    warn "~/bin is not in PATH — add this to your shell profile:"
    warn "  export PATH=\"\$HOME/bin:\$PATH\""
  fi
}

install_grim_link

# ── 6. Claude Code — MCP + plugin ─────────────────────────────────────────────
step "Configuring Claude Code..."

CLAUDE_BIN=$(which claude 2>/dev/null || true)
if [[ -z "$CLAUDE_BIN" ]]; then
  warn "claude CLI not found — skipping Claude Code setup"
  warn "Install Claude Code then run: claude mcp add --transport http grimoire http://aid:3663/mcp --scope user"
else
  # MCP server
  if claude mcp list 2>/dev/null | grep -q 'grimoire'; then
    ok "grimoire MCP server already configured"
  else
    claude mcp add --transport http grimoire http://aid:3663/mcp --scope user 2>/dev/null \
      && ok "grimoire MCP server registered (http://aid:3663/mcp)" \
      || warn "MCP registration failed — run manually: claude mcp add --transport http grimoire http://aid:3663/mcp --scope user"
  fi

  # Plugin marketplace + install
  MARKETPLACE_DIR="$HOME/data/claude-plugins"
  MARKETPLACE_JSON="$MARKETPLACE_DIR/.claude-plugin/marketplace.json"

  if claude plugin list 2>/dev/null | grep -q 'grimoire'; then
    ok "grimoire plugin already installed"
  else
    # Set up local marketplace pointing at this repo's plugin dir
    mkdir -p "$MARKETPLACE_DIR/.claude-plugin"
    mkdir -p "$MARKETPLACE_DIR/plugins"

    # Symlink or copy plugin dir
    if [[ ! -e "$MARKETPLACE_DIR/plugins/grimoire" ]]; then
      ln -s "$ENGINE_ROOT/plugin" "$MARKETPLACE_DIR/plugins/grimoire"
    fi

    cat > "$MARKETPLACE_JSON" <<EOF
{
  "\$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "local-plugins",
  "description": "Local Claude Code plugins",
  "owner": { "name": "local" },
  "plugins": [
    {
      "name": "grimoire",
      "description": "Personal knowledge graph — persistent memory, personas, session lifecycle",
      "category": "productivity",
      "source": "./plugins/grimoire"
    }
  ]
}
EOF

    claude plugin marketplace add "$MARKETPLACE_DIR" 2>/dev/null || true
    claude plugin install grimoire --scope user 2>/dev/null \
      && ok "grimoire plugin installed" \
      || warn "plugin install failed — run manually: claude plugin install grimoire --scope user"
  fi
fi

# ── 7. Smoke test ─────────────────────────────────────────────────────────────
step "Testing connection to aid:3663..."
if curl -sf http://aid:3663/health -o /dev/null 2>/dev/null; then
  HEALTH=$(curl -s http://aid:3663/health)
  ok "Grimoire server reachable — $HEALTH"
else
  warn "Cannot reach http://aid:3663/health"
  warn "Make sure the server is running on aid: grim serve  (or systemctl start grimoire)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "░ Setup complete."
echo "  Restart Claude Code to activate the MCP tools, then: /load"
echo ""
