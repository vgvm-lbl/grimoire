#!/usr/bin/env node
'use strict'

/**
 * grim-jot.js — Zero-friction thought capture
 *
 * Default: straight to noise floor, no LLM, instant.
 * --on <id>: annotate an existing KB entity instead.
 * --kb: ask Ollama to draft + write a DefinedTerm.
 *
 * CLI:
 *   grim jot "sensors before control plane"
 *   grim jot "this is the missing piece" --on concept_homelab_ai_service_orchestration
 *   grim jot "validFrom/validUntil on entities is the next big thing" --kb
 *   echo "thought from a pipe" | grim jot
 *
 * Shell alias for zero friction (add to ~/.bashrc):
 *   alias jot='grim jot'
 */

const fs       = require('node:fs')
const path     = require('node:path')
const minimist = require('minimist')
const axios    = require('axios')

const { config, isLocal, isRemote, requireMode } = require('../lib/env')
const { loadGraph, loadEntity, saveEntity }       = require('../lib/graph')
const { ask, askJSON }                            = require('./model-ask')

// ── Noise floor ───────────────────────────────────────────────────────────────

async function toNoiseFloor(text) {
  const thought = { at: new Date().toISOString(), text, source: 'jot', type: 'observation' }

  if (isLocal) {
    const file   = path.join(config.root, 'noise-floor.json')
    let thoughts = []
    try { thoughts = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    thoughts.push(thought)
    fs.writeFileSync(file, JSON.stringify(thoughts.slice(-500), null, 2), 'utf8')
    return { ok: true, count: thoughts.length }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/noise-floor/think`, thought)
    return res.data
  }

  requireMode('any')
}

// ── Annotate ──────────────────────────────────────────────────────────────────

async function annotate(entityId, note) {
  if (isLocal) {
    const graph  = await loadGraph()
    if (!graph.entities[entityId]) throw new Error(`Entity not found: ${entityId}`)
    const entity = loadEntity(entityId, graph)
    entity.notes = entity.notes || []
    entity.notes.push(`[${new Date().toISOString().slice(0, 10)}] ${note}`)
    saveEntity(entityId, entity, graph)
    const { scribe } = require('./grim-scribe')
    scribe()
    return { ok: true, id: entityId, noteCount: entity.notes.length }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/api/tome/annotate`, { entityId, note })
    return res.data
  }

  requireMode('any')
}

// ── KB draft ──────────────────────────────────────────────────────────────────

async function kbDraft(text) {
  const today = new Date().toISOString().slice(0, 10)

  const prompt = `A user jotted this thought: "${text}"

Draft a minimal knowledge graph entity. Return valid JSON only, no prose:
{
  "type": "DefinedTerm",
  "name": "<short name>",
  "description": "<1-3 sentences — what this IS, for a reader who'll see it in 6 months>",
  "tags": ["<tag1>", "<tag2>"]
}`

  let draft
  try {
    draft = await askJSON({ prompt, task: 'extraction', timeout: 30000 })
  } catch {
    return null
  }

  // Sanity check
  if (!draft?.name || !draft?.description) return null

  // Write to KB
  const { writeEntity } = require('../lib/entities')
  const { scribe }      = require('./grim-scribe')
  const graph           = await loadGraph()

  const result = writeEntity({
    '@type':     draft.type || 'DefinedTerm',
    name:        draft.name,
    description: draft.description,
    tags:        draft.tags || [],
  }, graph)

  if (!result.created) return { ok: false, reason: 'duplicate', id: result.id }

  scribe()
  return { ok: true, id: result.id, file: result.file, name: draft.name }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['kb', 'json'],
    alias:   { j: 'json', o: 'on' },
    string:  ['on'],
  })

  requireMode('any')

  // Accept text from args or stdin (pipe-friendly)
  let text = args._.join(' ').trim()
  if (!text && !process.stdin.isTTY) {
    text = fs.readFileSync('/dev/stdin', 'utf8').trim()
  }

  if (!text) {
    console.error('Usage: grim jot "<thought>" [--on <entity-id>] [--kb]')
    console.error('       echo "thought" | grim jot')
    process.exit(1)
  }

  let result

  if (args.on) {
    result = await annotate(args.on, text)
    if (!args.json) {
      if (result.ok) console.log(`  ✓  Annotated ${result.id}  (${result.noteCount} notes)`)
      else           console.log(`  ✗  ${result.reason || 'error'}`)
    }

  } else if (args.kb) {
    if (!args.json) process.stdout.write('  …  drafting KB entity… ')
    result = await kbDraft(text)
    if (!args.json) {
      if (!result)         console.log('\n  ✗  Ollama returned nothing useful — try being more specific')
      else if (result.ok)  console.log(`\n  ✓  Remembered: ${result.id}`)
      else                 console.log(`\n  ~  Already exists: ${result.id}`)
    }

  } else {
    result = await toNoiseFloor(text)
    if (!args.json) console.log(`  ✓  Jotted  (${result.count} thoughts on the floor)`)
  }

  if (args.json && result) console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
