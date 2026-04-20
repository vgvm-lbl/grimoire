#!/usr/bin/env node
'use strict'

/**
 * grim.js — Grimoire CLI dispatcher
 *
 * Usage:
 *   grim <command> [args...]
 *   grim --help
 */

const path    = require('node:path')
const { spawnSync } = require('node:child_process')

const COMMANDS = {
  'scribe':    { script: 'grim-scribe.js',   desc: 'Rebuild the graph index           (The Scribe)'    },
  'oracle':    { script: 'grim-oracle.js',   desc: 'Search the knowledge graph        (The Oracle)'    },
  'crawl':     { script: 'grim-crawl.js',    desc: 'Extract entities from notes       (The Crawl)'     },
  'divine':    { script: 'grim-divine.js',   desc: 'Validate graph health             (Divination)'    },
  'pathfind':  { script: 'grim-pathfind.js', desc: 'Link orphan entities              (Pathfinder)'    },
  'rest':      { script: 'grim-rest.js',     desc: 'Run dream analysis                (Long Rest)'     },
  'load':      { script: 'grim-session.js',  desc: 'Load save — begin a session       (SAVESTATE)'     },
  'save':      { script: 'grim-session.js',  desc: 'Write save — end a session        (SAVESTATE)'     },
  'tome':      { script: 'grim-tome.js',     desc: 'Memory ops: recall/remember/relate (The Tome)'     },
  'think':         { script: 'grim-think.js',         desc: 'Delegate thinking to Ollama            (The Oracle Mind)'   },
  'vision':        { script: 'grim-vision.js',        desc: 'Cast image spells, interrogate images  (The Vision)'      },
  'archaeologist': { script: 'grim-archaeologist.js', desc: 'Catalog old code into the KB            (The Archaeologist)' },
  'models':        { script: 'grim-models.js',        desc: 'Show resolved model routing table       (The Router)'       },
  'serve':     { script: 'grim-server.js',   desc: 'Start the Grimoire HTTP+MCP server'                },
}

const cmd = process.argv[2]

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
  ░██████╗░██████╗░██╗███╗░░░███╗░█████╗░██╗██████╗░███████╗
  ██╔════╝░██╔══██╗██║████╗░████║██╔══██╗██║██╔══██╗██╔════╝
  ██║░░██╗░██████╔╝██║██╔████╔██║██║░░██║██║██████╔╝█████╗░░
  ██║░░╚██╗██╔══██╗██║██║╚██╔╝██║██║░░██║██║██╔══██╗██╔══╝░░
  ╚██████╔╝██║░░██║██║██║░╚═╝░██║╚█████╔╝██║██║░░██║███████╗
  ░╚═════╝░╚═╝░░╚═╝╚═╝╚═╝░░░░╚═╝░╚════╝░╚═╝╚═╝░░╚═╝╚══════╝

  Grimoire Ex Machina.
  A wizard's personal knowledge graph.
  Runs on local models. Knows everything. Costs nothing.

Commands:
`)
  const width = Math.max(...Object.keys(COMMANDS).map(k => k.length))
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.log(`  grim ${name.padEnd(width + 2)} ${desc}`)
  }
  console.log(`
Environment:
  GRIMOIRE_ROOT        Path to grimoire data dir (default: repo root)
  OLLAMA_HOST          Ollama base URL           (default: http://localhost:11434)
  GRIMOIRE_A1111_HOST  AUTOMATIC1111 URL         (default: http://aid:7860)
  GRIMOIRE_VISION_OUT  Output dir for cast spells (default: /tmp)
`)
  process.exit(0)
}

const entry = COMMANDS[cmd]
if (!entry) {
  console.error(`grim: unknown command '${cmd}'`)
  console.error(`Run 'grim --help' for usage.`)
  process.exit(1)
}

const scriptPath = path.join(__dirname, entry.script)

if (!require('node:fs').existsSync(scriptPath)) {
  console.error(`grim: '${cmd}' is not built yet (${entry.script} not found)`)
  process.exit(1)
}

// Spawn the script as its own process so require.main === module works correctly
// inside each script (required by grim-server.js for shared modules).
const result = spawnSync(
  process.execPath,
  [scriptPath, cmd, ...process.argv.slice(3)],
  { stdio: 'inherit', env: process.env }
)
process.exit(result.status ?? 1)
