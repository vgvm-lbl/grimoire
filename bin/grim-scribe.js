#!/usr/bin/env node
'use strict'

/**
 * grim-scribe.js — The Scribe
 *
 * Walks the entities/ directory, reads every JSON file, and writes
 * knowledge-graph/indexes/graph.json — the single source of truth for
 * all other Grimoire tools.
 *
 * Run this any time entities change.
 *
 * CLI:
 *   node grim-scribe.js              # Rebuild, human-readable output
 *   node grim-scribe.js --json       # Rebuild, stats as JSON
 *   node grim-scribe.js --verbose    # Show per-file errors
 */

const fs       = require('node:fs')
const path     = require('node:path')
const minimist = require('minimist')
const { config, requireMode } = require('../lib/env')
const { buildIndex, indexReady } = require('../lib/vectors')

requireMode('local')
const KB_ROOT = config.root

const ENTITIES_DIR = path.join(KB_ROOT, 'entities')
const INDEXES_DIR  = path.join(KB_ROOT, 'indexes')
const GRAPH_FILE   = path.join(INDEXES_DIR, 'graph.json')

// ── Helpers ──────────────────────────────────────────────────────────────────

function walkJson(dir) {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())            results.push(...walkJson(full))
    else if (entry.name.endsWith('.json')) results.push(full)
  }
  return results
}

function slugify(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

// ── Core ─────────────────────────────────────────────────────────────────────

function scribe({ verbose = false } = {}) {
  fs.mkdirSync(INDEXES_DIR, { recursive: true })

  const files    = walkJson(ENTITIES_DIR)
  const entities = {}
  const edges    = []
  const backlinks = {}
  const tags     = {}
  const index    = {}
  const errors   = []

  for (const file of files) {
    let entity
    try {
      entity = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      errors.push({ file, error: `JSON parse error: ${e.message}` })
      continue
    }

    const id = entity['@id']
    if (!id) {
      errors.push({ file, error: 'missing @id' })
      continue
    }

    const relPath = path.relative(KB_ROOT, file)

    // Entity summary stored in the index (not full entity — keeps graph.json lean)
    entities[id] = {
      '@type':         entity['@type']        || null,
      '@id':           id,
      'name':          entity.name            || null,
      'description':   entity.description     || null,
      'tags':          entity.tags            || [],
      'relationships': entity.relationships   || {},
      'file':          relPath,
    }

    // Edges
    for (const [type, targets] of Object.entries(entity.relationships || {})) {
      const targetList = Array.isArray(targets) ? targets : [targets]
      for (const to of targetList) {
        if (!to) continue
        edges.push({ from: id, to, type })
        if (!backlinks[to]) backlinks[to] = []
        if (!backlinks[to].includes(id)) backlinks[to].push(id)
      }
    }

    // Tag index
    for (const tag of (entity.tags || [])) {
      if (!tags[tag]) tags[tag] = []
      tags[tag].push(id)
    }

    // Name resolution — multiple forms for fuzzy matching
    if (entity.name) {
      index[slugify(entity.name)]  = id
      index[id.toLowerCase()]      = id

      // Alternate names
      for (const alt of (entity.alternateName ? [entity.alternateName].flat() : [])) {
        index[slugify(alt)] = id
      }
    }
  }

  const graph = {
    entities,
    edges,
    backlinks,
    tags,
    index,
    _meta: {
      builtAt:     new Date().toISOString(),
      entityCount: Object.keys(entities).length,
      edgeCount:   edges.length,
      tagCount:    Object.keys(tags).length,
      errorCount:  errors.length,
      errors:      verbose ? errors : undefined,
    }
  }

  fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2))

  return { graph, errors }
}

/**
 * Async: rebuild graph then incrementally update the vector index.
 * @param {object} [opts]
 * @param {boolean} [opts.force]   - re-embed all entities
 * @param {boolean} [opts.verbose]
 * @returns {Promise<{graph, errors, vectors}>}
 */
async function scribeAll({ force = false, verbose = false } = {}) {
  const { graph, errors } = scribe({ verbose })

  let vectors = null
  try {
    const total = Object.keys(graph.entities).length
    process.stdout.write(`  Embedding  : `)
    let last = 0
    vectors = await buildIndex(graph, {
      force,
      onProgress(done, t) {
        const pct = Math.floor((done / t) * 20)
        if (pct > last) { process.stdout.write('█'.repeat(pct - last)); last = pct }
      },
    })
    process.stdout.write(`\n`)
  } catch (e) {
    vectors = { error: e.message }
  }

  return { graph, errors, vectors }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json', 'verbose', 'no-embed', 'force-embed'],
    alias: { j: 'json', v: 'verbose' }
  })

  const skipEmbed = args['no-embed']
  const force     = args['force-embed']

  if (skipEmbed) {
    const { graph, errors } = scribe({ verbose: args.verbose })
    const m = graph._meta
    if (args.json) {
      console.log(JSON.stringify({ entityCount: m.entityCount, edgeCount: m.edgeCount, tagCount: m.tagCount, errorCount: m.errorCount, builtAt: m.builtAt }, null, 2))
    } else {
      console.log(`  The Scribe has spoken.`)
      console.log(`  Entities : ${m.entityCount}  Edges : ${m.edgeCount}  Tags : ${m.tagCount}`)
      if (errors.length) console.warn(`  Errors   : ${errors.length}${args.verbose ? '' : ' (--verbose for details)'}`)
      if (args.verbose) for (const e of errors) console.error(`    ✗ ${path.relative(ENTITIES_DIR, e.file)}: ${e.error}`)
    }
    return
  }

  const { graph, errors, vectors } = await scribeAll({ force, verbose: args.verbose })
  const m = graph._meta

  if (args.json) {
    console.log(JSON.stringify({ entityCount: m.entityCount, edgeCount: m.edgeCount, tagCount: m.tagCount, errorCount: m.errorCount, builtAt: m.builtAt, vectors }, null, 2))
  } else {
    console.log(`  The Scribe has spoken.`)
    console.log(`  Entities : ${m.entityCount}  Edges : ${m.edgeCount}  Tags : ${m.tagCount}`)
    if (vectors?.error)   console.warn(`  Vectors  : failed — ${vectors.error}`)
    else if (vectors)     console.log(`  Vectors  : +${vectors.added} new  ~${vectors.updated} updated  ${vectors.skipped} unchanged`)
    if (errors.length)    console.warn(`  Errors   : ${errors.length}${args.verbose ? '' : ' (--verbose for details)'}`)
    if (args.verbose) for (const e of errors) console.error(`    ✗ ${path.relative(ENTITIES_DIR, e.file)}: ${e.error}`)
  }
}

module.exports = { scribe, scribeAll, KB_ROOT, ENTITIES_DIR, INDEXES_DIR, GRAPH_FILE }

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
