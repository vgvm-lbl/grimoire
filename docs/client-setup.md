# Setting Up a Grimoire Client

This guide covers connecting a new machine on your LAN to the Grimoire server running on `aid`.

---

## Prerequisites

- Grimoire server is running on `aid` (`grim serve` — see server setup)
- Port **3666** is open on `aid`'s firewall (see below)
- Node.js 18+ installed on the client

---

## 1. Resolve `aid` on the client

Add `aid` to the client's hosts file so `http://aid:3666` resolves correctly.

Find the IP of `aid` first (run on `aid`):
```bash
ip addr show | grep 'inet ' | grep -v 127.0.0.1
# e.g. 192.168.1.42
```

Then on the client machine:
```bash
# Linux / macOS
sudo echo "192.168.1.42  aid" >> /etc/hosts

# Windows (run as Administrator)
# Add to C:\Windows\System32\drivers\etc\hosts:
# 192.168.1.42  aid
```

Verify:
```bash
ping aid
curl http://aid:3666/health
# → {"status":"ok","entities":7,"edges":5}
```

---

## 2. Install the Grimoire engine

```bash
git clone <grimoire-repo-url> ~/src/me/grimoire
cd ~/src/me/grimoire
npm install
```

Or if you want `grim` available globally:
```bash
npm install -g .
```

---

## 3. Configure .env

```bash
cp .env.example .env
```

Edit `.env` — for a remote client, set `GRIMOIRE_HOST` and leave `GRIMOIRE_ROOT` commented out:

```bash
# Remote mode — no local KB access
GRIMOIRE_HOST=http://aid:3666

# Leave GRIMOIRE_ROOT unset (or comment it out)
# GRIMOIRE_ROOT=~/data/grimoire-kb

# Ollama — point at aid to use its models remotely
OLLAMA_HOST=http://aid:11434
```

---

## 4. Configure Claude Code (MCP)

Add Grimoire as an MCP server in your Claude Code project config (`.mcp.json` in the project root, or `~/.claude/mcp.json` globally):

```json
{
  "mcpServers": {
    "grimoire": {
      "type": "http",
      "url": "http://aid:3666/mcp"
    }
  }
}
```

Claude Code will now have access to Grimoire tools directly:
- `grimoire_oracle` — search the knowledge graph
- `grimoire_tome_recall` — recall an entity by name
- `grimoire_tome_remember` — create a new entity
- `grimoire_session_load` — load last save state
- `grimoire_session_save` — write current session

---

## 5. Verify

```bash
# Test Oracle (remote mode)
grim oracle "grimoire"

# Should return the Grimoire agent model entity
# If you get "Could not reach Grimoire server" — check firewall (step below)
```

---

## Firewall: Opening Port 3666 on `aid`

Run these on `aid`:

### ufw (Ubuntu/Debian default)
```bash
sudo ufw allow 3666/tcp comment 'Grimoire server'
sudo ufw reload
sudo ufw status
```

### firewalld (Fedora/RHEL/Arch)
```bash
sudo firewall-cmd --permanent --add-port=3666/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

### iptables (manual)
```bash
sudo iptables -A INPUT -p tcp --dport 3666 -j ACCEPT
# Persist with iptables-save or your distro's method
```

### Verify the port is open (from a client):
```bash
nc -zv aid 3666
# or
curl -s http://aid:3666/health | python3 -m json.tool
```

---

## Ports Reference

| Port | Service | Direction | Notes |
|------|---------|-----------|-------|
| 3666 | Grimoire HTTP + MCP | LAN inbound | Required for all client tools |
| 11434 | Ollama | LAN inbound | Optional — only if clients query Ollama directly |

---

## Local vs Remote mode summary

| Command | Local (aid) | Remote (client) |
|---------|------------|-----------------|
| `grim scribe` | ✓ | ✗ (needs direct KB access) |
| `grim crawl` | ✓ | ✗ (needs direct KB access) |
| `grim pathfind` | ✓ | ✗ (needs direct KB access) |
| `grim rest` | ✓ | ✗ (needs direct KB access) |
| `grim oracle` | ✓ | ✓ (via server) |
| `grim divine` | ✓ | ✓ (via server) |
| `grim tome` | ✓ | ✓ (via server) |
| `grim load` | ✓ | ✓ (via server) |
| `grim save` | ✓ | ✓ (via server) |

Write operations via server (tome remember, relate) are proxied through the server to the KB on `aid`.
