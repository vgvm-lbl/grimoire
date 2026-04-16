# Server Setup (aid)

How to set up Grimoire on `aid` — the machine that owns the KB.

---

## 1. Clone repos

```bash
cd /mnt/eighty/userspace/vgvm/data
git clone <engine-repo> grimoire
git clone <kb-repo>     grimoire-kb
```

## 2. Install dependencies

```bash
cd grimoire
npm install
```

## 3. Configure environment

```bash
cp .env.example .env
```

`.env` on `aid` (local mode — direct KB access):
```bash
GRIMOIRE_ROOT=/mnt/eighty/userspace/vgvm/data/grimoire-kb
OLLAMA_HOST=http://localhost:11434
GRIMOIRE_PORT=3666
```

## 4. Verify Ollama is running

```bash
curl http://localhost:11434/api/tags
# Should list your models
```

## 5. Hosts file entry

`aid` should resolve to localhost on this machine:
```bash
grep aid /etc/hosts
# Should show: 127.0.0.1  aid
# or: 127.0.1.1  aid
```

If missing:
```bash
echo "127.0.0.1  aid" | sudo tee -a /etc/hosts
```

## 6. Open firewall port

```bash
# ufw
sudo ufw allow 3666/tcp comment 'Grimoire server'
sudo ufw reload
```

## 7. Build the initial index

```bash
node bin/grim-scribe.js
# 📖 The Scribe has spoken.
#    Entities : 7
```

## 8. Start the server

```bash
node bin/grim-server.js
# Grimoire online. http://0.0.0.0:3666
```

### Run as a systemd service (persistent across reboots)

```bash
sudo tee /etc/systemd/system/grimoire.service > /dev/null <<EOF
[Unit]
Description=Grimoire Knowledge Graph Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/mnt/eighty/userspace/vgvm/data/grimoire
EnvironmentFile=/mnt/eighty/userspace/vgvm/data/grimoire/.env
ExecStart=$(which node) bin/grim-server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable grimoire
sudo systemctl start grimoire
sudo systemctl status grimoire
```

## 9. Nightly ritual (cron)

```bash
crontab -e
# Add:
17 19 * * 1-5 cd /mnt/eighty/userspace/vgvm/data/grimoire && node bin/grim-ritual.js >> /mnt/eighty/userspace/vgvm/data/grimoire-kb/logs/ritual.log 2>&1
```

Schedule during work hours when Ollama auth/state is warm. Avoid 2 AM.

---

## Verify everything

```bash
# Health check
curl http://localhost:3666/health

# From another LAN machine
curl http://aid:3666/health
# → {"status":"ok","entities":7,"edges":5}
```
