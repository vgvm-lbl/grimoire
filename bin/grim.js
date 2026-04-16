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

  A wizard's personal knowledge graph.
  Runs on local models. Knows everything. Costs nothing. FreeKB.

Commands:
`)
  const width = Math.max(...Object.keys(COMMANDS).map(k => k.length))
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.log(`  grim ${name.padEnd(width + 2)} ${desc}`)
  }
  console.log(`
Environment:
  GRIMOIRE_ROOT   Path to grimoire data dir (default: repo root)
  OLLAMA_HOST     Ollama base URL (default: http://localhost:11434)
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
