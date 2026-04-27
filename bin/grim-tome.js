#!/usr/bin/env node
'use strict'

/**
 * grim-tome.js — The Tome
 *
 * Cognitive memory operations: recall, remember, relate, annotate, forget.
 * Read ops work local + remote. Write ops require local or a running server.
 *
 * CLI (via grim tome <subcommand>):
 *   grim tome recall "jane smith"               Search + full entity details
 *   grim tome recall "jane smith" --depth 1     Include related entities
 *   grim tome remember --type Person --name "Jane Smith" --desc "Tech lead"
 *   grim tome relate person_jane_smith project_proj_101 works_on
 *   grim tome annotate person_jane_smith "Started new role Q2 2026"
 *   grim tome forget person_jane_smith          [local only, destructive]
 */

const fs        = require('node:fs')
const path      = require('node:path')
const minimist  = require('minimist')
const axios     = require('axios')
const { loadGraph, loadEntity, saveEntity } = require('../lib/graph')
const { writeEntity, toId }                 = require('../lib/entities')
const { config, isLocal, isRemote, requireMode } = require('../lib/env')
const { search }                            = require('./grim-oracle')

// ── Read ops (local + remote) ─────────────────────────────────────────────────

async function recall(query, { depth = 1 } = {}) {
  const graph   = await loadGraph()
  const results = search(graph, { query, depth, limit: 5 })
  return results
}

// ── Write ops ─────────────────────────────────────────────────────────────────

async function remember(entityData) {
  if (isLocal) {
    const graph  = await loadGraph()
    const result = writeEntity(entityData, graph)

    if (!result.created) {
      return { ok: false, reason: 'duplicate', id: result.id }
    }

    // Rebuild index
    const { scribe } = require('./grim-scribe')
    scribe()
    return { ok: true, id: result.id, file: result.file }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/api/tome/remember`, entityData)
    return res.data
  }

  requireMode('any')
}

async function relate(fromId, toId, relationType) {
  if (isLocal) {
    const graph  = await loadGraph()

    if (!graph.entities[fromId]) throw new Error(`Entity not found: ${fromId}`)
    if (!graph.entities[toId])   throw new Error(`Entity not found: ${toId}`)

    const entity = loadEntity(fromId, graph)
    entity.relationships = entity.relationships || {}
    const existing = entity.relationships[relationType]

    if (Array.isArray(existing)) {
      if (!existing.includes(toId)) existing.push(toId)
    } else if (existing) {
      if (existing !== toId) entity.relationships[relationType] = [existing, toId]
    } else {
      entity.relationships[relationType] = [toId]
    }

    saveEntity(fromId, entity, graph)

    const { scribe } = require('./grim-scribe')
    scribe()
    return { ok: true, from: fromId, to: toId, type: relationType }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/api/tome/relate`, { fromId, toId, relationType })
    return res.data
  }

  requireMode('any')
}

async function annotate(entityId, note) {
  if (isLocal) {
    const graph  = await loadGraph()
    if (!graph.entities[entityId]) throw new Error(`Entity not found: ${entityId}`)

    const entity  = loadEntity(entityId, graph)
    entity.notes  = entity.notes || []
    entity.notes.push(`[${new Date().toISOString().slice(0, 10)}] ${note}`)

    saveEntity(entityId, entity, graph)
    return { ok: true, id: entityId, noteCount: entity.notes.length }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/api/tome/annotate`, { entityId, note })
    return res.data
  }

  requireMode('any')
}

async function update(entityId, patches) {
  if (isLocal) {
    const graph = await loadGraph()
    if (!graph.entities[entityId]) throw new Error(`Entity not found: ${entityId}`)

    const entity = loadEntity(entityId, graph)

    if (patches.name          !== undefined) entity.name        = patches.name
    if (patches.description   !== undefined) entity.description = patches.description
    if (patches.tags          !== undefined) entity.tags        = patches.tags
    if (patches.lastVerified  === true) {
      entity.metadata = entity.metadata || {}
      entity.metadata.lastVerified = new Date().toISOString().slice(0, 10)
    }

    if (patches.relationships) {
      entity.relationships = entity.relationships || {}
      for (const [rel, targets] of Object.entries(patches.relationships)) {
        const existing = entity.relationships[rel]
        const incoming = Array.isArray(targets) ? targets : [targets]
        if (!existing) {
          entity.relationships[rel] = incoming
        } else {
          const base = Array.isArray(existing) ? existing : [existing]
          entity.relationships[rel] = [...new Set([...base, ...incoming])]
        }
      }
    }

    saveEntity(entityId, entity, graph)

    const { scribe } = require('./grim-scribe')
    scribe()
    return { ok: true, id: entityId }
  }

  if (isRemote) {
    const res = await axios.post(`${config.host}/api/tome/update`, { id: entityId, ...patches })
    return res.data
  }

  requireMode('any')
}

async function forget(entityId) {
  requireMode('local')

  const graph = await loadGraph()
  const entry = graph.entities[entityId]
  if (!entry) throw new Error(`Entity not found: ${entityId}`)

  const file = path.join(config.root, entry.file)
  fs.unlinkSync(file)

  const { scribe } = require('./grim-scribe')
  scribe()
  return { ok: true, id: entityId, removed: file }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatRecall(results) {
  if (!results.length) {
    console.log('\n  Nothing found.\n')
    return
  }
  for (const { entity, hops } of results) {
    const hopNote = hops > 0 ? `  (hop ${hops})` : ''
    console.log(`\n  [${entity['@type']}] ${entity.name}${hopNote}  —  ${entity['@id']}`)
    if (entity.description) console.log(`  ${entity.description}`)
    if (entity.tags?.length) console.log(`  Tags: ${entity.tags.join(', ')}`)
    const rels = Object.entries(entity.relationships || {})
    if (rels.length) {
      for (const [type, targets] of rels) {
        const ids = Array.isArray(targets) ? targets : [targets]
        console.log(`  → ${type}: ${ids.join(', ')}`)
      }
    }
  }
  console.log()
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const sub  = process.argv[2]  // subcommand injected by grim.js dispatcher
  const args = minimist(process.argv.slice(3), {
    boolean: ['json'],
    alias:   { j: 'json', d: 'depth' },
    string:  ['type', 'name', 'desc', 'tags'],
    default: { depth: 1 },
  })

  requireMode('any')

  switch (sub) {
    case 'recall': {
      const query   = args._.join(' ').trim()
      if (!query) { console.error('Usage: grim tome recall <query>'); process.exit(1) }
      const results = await recall(query, { depth: Number(args.depth) })
      if (args.json) console.log(JSON.stringify(results, null, 2))
      else           formatRecall(results)
      break
    }

    case 'remember': {
      if (!args.type || !args.name) {
        console.error('Usage: grim tome remember --type <type> --name <name> [--desc <desc>] [--tags tag1,tag2]')
        process.exit(1)
      }
      const tags = args.tags ? args.tags.split(',').map(t => t.trim()) : []
      const result = await remember({
        '@type':      args.type,
        name:         args.name,
        description:  args.desc || '',
        tags,
      })
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else if (result.ok) console.log(`  Remembered: ${result.id}`)
      else console.log(`  Already exists: ${result.id}`)
      break
    }

    case 'relate': {
      const [fromId, toId_, relationType] = args._
      if (!fromId || !toId_ || !relationType) {
        console.error('Usage: grim tome relate <fromId> <toId> <relationType>')
        process.exit(1)
      }
      const result = await relate(fromId, toId_, relationType)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`  Linked: ${fromId} → ${relationType} → ${toId_}`)
      break
    }

    case 'annotate': {
      const [entityId, ...noteParts] = args._
      const note = noteParts.join(' ').trim()
      if (!entityId || !note) {
        console.error('Usage: grim tome annotate <entityId> <note text>')
        process.exit(1)
      }
      const result = await annotate(entityId, note)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`  Annotated: ${entityId}`)
      break
    }

    case 'update': {
      const [entityId] = args._
      if (!entityId) {
        console.error('Usage: grim tome update <entityId> [--name <name>] [--desc <desc>] [--tags tag1,tag2]')
        process.exit(1)
      }
      const patches = {}
      if (args.name !== undefined) patches.name        = args.name
      if (args.desc !== undefined) patches.description = args.desc
      if (args.tags !== undefined) patches.tags        = args.tags.split(',').map(t => t.trim())
      const result = await update(entityId, patches)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else if (result.ok) console.log(`  Updated: ${result.id}`)
      else console.log(`  Error: ${result.reason || 'unknown'}`)
      break
    }

    case 'forget': {
      const [entityId] = args._
      if (!entityId) { console.error('Usage: grim tome forget <entityId>'); process.exit(1) }
      const result = await forget(entityId)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`  Forgotten: ${entityId}`)
      break
    }

    default:
      console.error('Usage: grim tome <recall|remember|update|relate|annotate|forget>')
      process.exit(1)
  }
}

module.exports = { recall, remember, update, relate, annotate, forget }

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
