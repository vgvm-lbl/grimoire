# Grimoire Ex Machina

A personal knowledge graph that runs on local models, knows everything, costs nothing, and is slightly unhinged.

---

## What it does

- Extracts structured entities from your unstructured notes (diary, meetings, docs)
- Links them with typed relationships (works_on, depends_on, collaborates_with)
- Maintains itself autonomously via a nightly ritual
- Gives AI assistants (Claude Code, etc.) persistent memory across sessions via MCP
- Supports personas (specialized AI behaviors) and cheat codes (lessons learned)

All data is **JSON files on disk** — no database, no external services. AI runs on local Ollama models.

---

## Architecture

```
grimoire/          Engine (this repo — public)
  bin/             CLI scripts
  lib/             Shared utilities
  docs/            Setup guides

grimoire-kb/       Knowledge base (separate private repo)
  entities/        JSON entity files (people, projects, concepts, events, ...)
  indexes/         Generated — graph.json (gitignored)
  logs/            Nightly ritual logs (gitignored)
```

The engine and KB are separate repos. The engine points at the KB via `GRIMOIRE_ROOT`.

---

## Commands

```
grim scribe            Rebuild graph index + vector embeddings   (The Scribe)        [local]
grim oracle            Search the KB — keyword + semantic hybrid  (The Oracle)        [local + remote]
grim crawl             Extract entities from notes/docs           (The Crawl)         [local]
grim divine            Validate graph health                      (Divination)        [local + remote]
grim pathfind          Link orphan entities via Rebel + Ollama    (Pathfinder)        [local]
grim rest              Long Rest deep analysis                    (Long Rest)         [local]
grim archaeologist     Catalog old code projects into KB          (The Archaeologist) [local + remote]
grim vision cast       Generate images via AUTOMATIC1111          (The Vision)        [local + remote]
grim vision interrogate  CLIP-caption images → entity hints       (The Vision)        [local + remote]
grim load              Load save — begin a session                (SAVESTATE)         [local + remote]
grim save              Write save — end a session                 (SAVESTATE)         [local + remote]
grim tome              Memory ops: recall/remember/relate         (The Tome)          [local + remote]
grim serve             Start HTTP + MCP server                                        [run on aid]
```

**Local** commands require `GRIMOIRE_ROOT` set and the KB directory accessible.
**Remote** commands require `GRIMOIRE_HOST` pointing at a running `grim serve`.

---

## Quick start (on aid)

```bash
git clone <this-repo> grimoire
git clone <kb-repo>   grimoire-kb

cd grimoire
npm install
cp .env.example .env
# Edit .env: set GRIMOIRE_ROOT to your grimoire-kb path

# Build the graph index
grim scribe

# Search
grim oracle "your query"

# Start server for LAN clients + Claude Code MCP
grim serve
```

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIMOIRE_ROOT` | — | Path to grimoire-kb directory (local mode) |
| `GRIMOIRE_HOST` | — | Grimoire server URL, e.g. `http://aid:3663` (remote mode) |
| `OLLAMA_HOST` | `http://aid:11434` | Ollama base URL |
| `GRIMOIRE_PORT` | `3663` | Port for `grim serve` |
| `GRIMOIRE_NER_HOST` | `http://aid:3773` | NER service (GLiNER + Rebel) |
| `GRIMOIRE_A1111_HOST` | `http://aid:7860` | AUTOMATIC1111 Stable Diffusion |
| `GRIMOIRE_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |

---

## AI model routing

All AI operations use local Ollama models — no cloud required.

| Task | Model |
|------|-------|
| Entity extraction / overview | gemma4:26b |
| Per-file linking (bulk) | gemma4:26b |
| Dream analysis / synthesis | gemma4:31b |
| Rumination / noise floor | qwen3.5:9b |
| Interactive reflection | gemma4:26b |

Models are resolved dynamically via `grim models` — routing uses installed models scored against capability profiles. Run `grim models` to see the current routing table for your hardware.

---

## Personas

Grimoire ships with five personas — specialized AI behavior modes:

| Name | Domain | Activates on |
|------|--------|-------------|
| GLITCH | Code review | "review", "open-pr", "pre-commit" |
| THE CRAWLER | Knowledge mining | "ingest", "extract entities", "crawl" |
| SAVESTATE | Memory / sessions | "load save", "write save", "resume" |
| GM | Architecture / reasoning | "architecture", "design", "tradeoffs" |
| LOREKEEPER | Documentation | "document", "readme", "explain" |

---

## Service ports

| Port | Service |
|------|---------|
| 3663 | Grimoire HTTP + MCP server |
| 3773 | NER service (GLiNER + Rebel) |
| 7860 | AUTOMATIC1111 |
| 11434 | Ollama |

Open port **3663** on aid for LAN clients. See [docs/client-setup.md](docs/client-setup.md).

---

## New machine setup

See [docs/client-setup.md](docs/client-setup.md) for full instructions including:
- Hosts file configuration (`aid` resolution)
- `.env` setup for remote mode
- Claude Code MCP configuration
- Firewall setup on aid
