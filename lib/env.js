'use strict'

/**
 * lib/env.js — Grimoire environment loader
 *
 * Loads .env from the engine root if present, then exports a config
 * object consumed by all grim-* scripts.
 *
 * Usage:
 *   const { config, isLocal, isRemote } = require('./env')
 */

const fs   = require('node:fs')
const path = require('node:path')

const ENV_FILE = path.join(__dirname, '..', '.env')

// Load .env once, only for keys not already in process.env
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const config = {
  // Path to the grimoire-kb directory (local mode)
  root:     process.env.GRIMOIRE_ROOT   || null,

  // Grimoire server address (remote mode) — e.g. http://aid:3663
  host:     process.env.GRIMOIRE_HOST   || null,

  // Ollama base URL
  ollama:   process.env.OLLAMA_HOST     || 'http://aid:11434',

  // Server port (when running grim-server on this machine)
  port:     parseInt(process.env.GRIMOIRE_PORT || '3663', 10),
}

// Local mode: GRIMOIRE_ROOT is set and the KB directory exists
const isLocal = !!(config.root && fs.existsSync(config.root))

// Remote mode: GRIMOIRE_HOST is set (server running somewhere on LAN)
const isRemote = !!(config.host)

/**
 * Assert that at least one mode is available, exit with a helpful message if not.
 * @param {'local'|'remote'|'any'} required
 */
function requireMode(required = 'any') {
  if (required === 'local' && !isLocal) {
    console.error('This command requires direct KB access (GRIMOIRE_ROOT).')
    console.error('Run it on aid, or set GRIMOIRE_ROOT in .env.')
    process.exit(1)
  }
  if (required === 'remote' && !isRemote) {
    console.error('This command requires a running Grimoire server (GRIMOIRE_HOST).')
    console.error('Set GRIMOIRE_HOST=http://aid:3663 in .env, then run: grim serve')
    process.exit(1)
  }
  if (required === 'any' && !isLocal && !isRemote) {
    console.error('Grimoire is not configured.')
    console.error('Set GRIMOIRE_ROOT (local) or GRIMOIRE_HOST (remote) in .env')
    process.exit(1)
  }
}

module.exports = { config, isLocal, isRemote, requireMode }
