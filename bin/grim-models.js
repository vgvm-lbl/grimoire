#!/usr/bin/env node
'use strict'

/**
 * grim-models.js — Show resolved model routing table
 *
 * Queries Ollama for installed models, scores them per task, and prints
 * the routing table that all grim commands will use.
 *
 * Usage:
 *   grim models
 */

const { buildRouteTable, getInstalledModels, OLLAMA_BASE, ALL_TASKS, resolveModel } = require('./model-ask')
const { CAPABILITY_PROFILES } = (() => {
  // Re-export from model-ask by reading the module — profiles aren't exported directly
  // so we reconstruct a summary from the installed models instead.
  return { CAPABILITY_PROFILES: null }
})()

async function main() {
  const [table, installed] = await Promise.all([buildRouteTable(), getInstalledModels()])

  console.log(`\n  Grimoire model router  (${OLLAMA_BASE})\n`)

  if (!installed.length) {
    console.log('  Ollama unreachable — showing static fallbacks\n')
  } else {
    console.log(`  Installed (${installed.length}): ${installed.join(', ')}\n`)
  }

  const width = Math.max(...ALL_TASKS.map(t => t.length))
  console.log('  Task routing:\n')
  for (const task of ALL_TASKS) {
    const r     = table[task]
    const flags = [r.thinking ? 'thinking' : '', r.score != null ? `score:${r.score}` : ''].filter(Boolean).join(', ')
    console.log(`  ${task.padEnd(width + 2)} → ${r.model}${flags ? `  (${flags})` : ''}`)
  }
  console.log()
}

main().catch(e => { console.error(e.message); process.exit(1) })
