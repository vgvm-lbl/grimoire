#!/usr/bin/env node
'use strict'

/**
 * grim-council.js — The Council
 *
 * Runs a topic through five expert personas simultaneously, then synthesizes
 * into a report that surfaces agreements, conflicts, unique catches, and the
 * question nobody wants to ask.
 *
 *   THE BUILDER    — what's worth building on
 *   THE SKEPTIC    — what's wrong and being hidden
 *   THE THEORIST   — what pattern this represents
 *   THE HISTORIAN  — why it was built this way
 *   THE COMMANDO   — what kills the mission
 *
 * CLI:
 *   grim council "should we build grim rig?"
 *   grim council "review this" --file path/to/doc.md
 *   grim council "topic" --context "oracle search query"
 *   grim council "topic" --personas builder,skeptic,commando
 *   grim council "topic" --json
 */

const fs       = require('node:fs')
const minimist = require('minimist')
const { PERSONAS, runCouncil } = require('../lib/council')
const { search }    = require('./grim-oracle')
const { loadGraph } = require('../lib/graph')
const { requireMode } = require('../lib/env')

const BAR = '─'.repeat(58)

function formatHuman({ takes, synthesis }) {
  console.log(`\n  THE COUNCIL CONVENES\n`)

  for (const [key, text] of Object.entries(takes)) {
    const name = PERSONAS[key]?.name || key.toUpperCase()
    console.log(`  ┌─ ${name} ${'─'.repeat(Math.max(0, 54 - name.length))}`)
    for (const line of text.split('\n')) {
      console.log(`  │ ${line}`)
    }
    console.log(`  └${BAR}\n`)
  }

  console.log(`  ┌─ SYNTHESIS ${'─'.repeat(46)}`)
  for (const line of synthesis.split('\n')) {
    console.log(`  │ ${line}`)
  }
  console.log(`  └${BAR}\n`)
}

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json'],
    alias:   { j: 'json', f: 'file', c: 'context' },
    string:  ['file', 'context', 'personas'],
    default: { timeout: 180000 },
  })

  requireMode('any')

  const topic = args._.join(' ').trim()
  if (!topic) {
    console.error('Usage: grim council "<topic>" [--file <path>] [--context <oracle-query>] [--personas builder,skeptic,...]')
    process.exit(1)
  }

  let context = ''

  if (args.file) {
    if (!fs.existsSync(args.file)) {
      console.error(`File not found: ${args.file}`)
      process.exit(1)
    }
    let raw = fs.readFileSync(args.file, 'utf8')
    if (raw.length > 8000) raw = raw.slice(0, 8000) + '\n[... truncated ...]'
    context = raw
  }

  if (args.context) {
    try {
      const graph   = await loadGraph()
      const results = search(graph, { query: args.context, limit: 6 })
      const lines = results.map(({ entity: e }) =>
        `[${e['@id']}] ${e['@type']} — ${e.name}: ${(e.description || '').slice(0, 150)}`
      )
      context += (context ? '\n\n' : '') + 'KB CONTEXT:\n' + lines.join('\n')
    } catch { /* proceed without */ }
  }

  const personas = args.personas ? args.personas.split(',').map(s => s.trim()) : null

  if (!args.json) {
    const names = (personas || Object.keys(PERSONAS))
      .map(k => PERSONAS[k]?.name || k)
      .join(', ')
    console.log(`\n  Convening: ${names}`)
    console.log(`  Topic: "${topic}"`)
    if (context) console.log(`  Context: ${context.length} chars`)
    console.log()
  }

  const result = await runCouncil(topic, context, {
    timeout:  Number(args.timeout) || 180000,
    personas,
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    formatHuman(result)
  }
}

module.exports = { runCouncil, PERSONAS }

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
