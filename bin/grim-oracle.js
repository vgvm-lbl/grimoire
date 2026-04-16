#!/usr/bin/env node
'use strict'

/**
 * grim-oracle.js — The Oracle
 *
 * Searches the Grimoire knowledge graph by name, content, tag, or type.
 * Optionally traverses relationships to a given depth.
 *
 * Works in two modes:
 *   Local  — reads graph.json directly (run on aid, GRIMOIRE_ROOT set)
 *   Remote — queries Grimoire server   (any host, GRIMOIRE_HOST set)
 *
 * CLI:
 *   grim oracle "jane smith"           Search by name / content
 *   grim oracle "jane" --depth 2       Include related entities (2 hops)
 *   grim oracle --tag domain/workflow  Filter by tag
 *   grim oracle --type Person          Filter by @type
 *   grim oracle "query" --json         Machine-readable output
 *   grim oracle --list-tags            Show all tags in the graph
 *   grim oracle --list-types           Show all entity types in the graph
 */

const minimist              = require('minimist')
const { loadGraph }         = require('../lib/graph')
const { requireMode }       = require('../lib/env')

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search the graph.
 * @param {object} graph
 * @param {object} opts
 * @param {string}  [opts.query]  - free-text search
 * @param {string}  [opts.tag]    - exact tag filter
 * @param {string}  [opts.type]   - @type filter
 * @param {number}  [opts.depth]  - relationship traversal depth (default 0)
 * @param {number}  [opts.limit]  - max results (default 20)
 * @returns {Array<{entity, score, hops}>}
 */
function search(graph, { query, tag, type, depth = 0, limit = 20 } = {}) {
  const results = new Map() // id → { entity, score, hops }

  // ── Seed results ───────────────────────────────────────────────────────────

  if (tag) {
    const ids = graph.tags[tag] || []
    for (const id of ids) {
      if (graph.entities[id]) results.set(id, { entity: graph.entities[id], score: 100, hops: 0 })
    }

  } else if (type) {
    const t = type.toLowerCase()
    for (const [id, entity] of Object.entries(graph.entities)) {
      if ((entity['@type'] || '').toLowerCase() === t) {
        results.set(id, { entity, score: 100, hops: 0 })
      }
    }

  } else if (query) {
    const q = query.toLowerCase().trim()

    // Exact name index lookup first
    const exactId = graph.index[q]
    if (exactId && graph.entities[exactId]) {
      results.set(exactId, { entity: graph.entities[exactId], score: 100, hops: 0 })
    }

    // Full scan for partial / content matches
    for (const [id, entity] of Object.entries(graph.entities)) {
      if (results.has(id)) continue

      const name = (entity.name        || '').toLowerCase()
      const desc = (entity.description || '').toLowerCase()
      const eid  = id.toLowerCase()
      const tags = (entity.tags || []).join(' ').toLowerCase()

      let score = 0
      if      (name === q || eid === q)     score = 100
      else if (name.startsWith(q))          score = 80
      else if (name.includes(q))            score = 60
      else if (desc.includes(q))            score = 40
      else if (eid.includes(q))             score = 30
      else if (tags.includes(q))            score = 20

      if (score > 0) results.set(id, { entity, score, hops: 0 })
    }
  }

  // ── Depth traversal ────────────────────────────────────────────────────────

  if (depth > 0) {
    let frontier = new Set(results.keys())
    for (let hop = 1; hop <= depth; hop++) {
      const next = new Set()
      for (const id of frontier) {
        const entity = graph.entities[id]
        if (!entity) continue

        // Outgoing edges
        for (const targets of Object.values(entity.relationships || {})) {
          for (const tid of (Array.isArray(targets) ? targets : [targets])) {
            if (tid && !results.has(tid) && graph.entities[tid]) {
              results.set(tid, { entity: graph.entities[tid], score: Math.max(1, 50 - hop * 15), hops: hop })
              next.add(tid)
            }
          }
        }

        // Backlinks (incoming edges)
        for (const bid of (graph.backlinks[id] || [])) {
          if (!results.has(bid) && graph.entities[bid]) {
            results.set(bid, { entity: graph.entities[bid], score: Math.max(1, 40 - hop * 15), hops: hop })
            next.add(bid)
          }
        }
      }
      frontier = next
    }
  }

  // ── Sort + limit ───────────────────────────────────────────────────────────

  return [...results.values()]
    .sort((a, b) => b.score - a.score || (a.entity.name || '').localeCompare(b.entity.name || ''))
    .slice(0, limit)
}

// ── Formatting ───────────────────────────────────────────────────────────────

const TYPE_ICON = {
  Person:              '👤',
  Project:             '📋',
  DefinedTerm:         '💡',
  Event:               '📅',
  SoftwareApplication: '⚙️ ',
  SoftwareSourceCode:  '📦',
  AgentModel:          '🤖',
  UserModel:           '🧑',
  HowTo:               '📜',
  Session:             '💾',
}

function icon(type) {
  return TYPE_ICON[type] || '◆ '
}

function truncate(str, n = 80) {
  if (!str) return ''
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

function formatHuman(results, { query, tag, type, depth }) {
  const qualifier = query ? `"${query}"` : tag ? `tag:${tag}` : type ? `type:${type}` : '(all)'
  const depthNote = depth > 0 ? ` (depth ${depth})` : ''

  if (results.length === 0) {
    console.log(`\n  No results for ${qualifier}\n`)
    return
  }

  console.log(`\n  ${results.length} result${results.length === 1 ? '' : 's'} for ${qualifier}${depthNote}\n`)

  for (const { entity, hops } of results) {
    const hopNote = hops > 0 ? `  ·  hop:${hops}` : ''
    const type_   = entity['@type'] || '?'

    console.log(`  ${icon(type_)} [${type_}] ${entity.name || entity['@id']}${hopNote}`)
    console.log(`     ${entity['@id']}`)
    if (entity.description) console.log(`     ${truncate(entity.description, 100)}`)
    if (entity.tags?.length) console.log(`     Tags: ${entity.tags.join(', ')}`)

    // Relationships
    const rels = entity.relationships || {}
    for (const [relType, targets] of Object.entries(rels)) {
      const ids = Array.isArray(targets) ? targets : [targets]
      console.log(`     → ${relType}: ${ids.join(', ')}`)
    }

    console.log()
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), { // slice(3): strip 'grim oracle'
    boolean: ['json', 'list-tags', 'list-types'],
    alias:   { j: 'json', d: 'depth', t: 'tag', l: 'limit' },
    default: { depth: 0, limit: 20 }
  })

  requireMode('any')
  const graph = await loadGraph()

  // ── Utility modes ──────────────────────────────────────────────────────────

  if (args['list-tags']) {
    const tags = Object.entries(graph.tags)
      .sort((a, b) => b[1].length - a[1].length)
    if (args.json) {
      console.log(JSON.stringify(Object.fromEntries(tags.map(([k, v]) => [k, v.length])), null, 2))
    } else {
      console.log('\n  Tags in the grimoire:\n')
      for (const [tag, ids] of tags) console.log(`  ${String(ids.length).padStart(4)}  ${tag}`)
      console.log()
    }
    return
  }

  if (args['list-types']) {
    const types = {}
    for (const entity of Object.values(graph.entities)) {
      const t = entity['@type'] || 'unknown'
      types[t] = (types[t] || 0) + 1
    }
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1])
    if (args.json) {
      console.log(JSON.stringify(Object.fromEntries(sorted), null, 2))
    } else {
      console.log('\n  Entity types in the grimoire:\n')
      for (const [t, n] of sorted) console.log(`  ${String(n).padStart(4)}  ${t}`)
      console.log()
    }
    return
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  const query = args._.join(' ').trim() || null
  const opts  = {
    query,
    tag:   args.tag   || null,
    type:  args.type  || null,
    depth: Number(args.depth),
    limit: Number(args.limit),
  }

  if (!opts.query && !opts.tag && !opts.type) {
    console.error('Usage: grim oracle <query>')
    console.error('       grim oracle --tag <tag>')
    console.error('       grim oracle --type <type>')
    console.error('       grim oracle --list-tags')
    console.error('       grim oracle --list-types')
    process.exit(1)
  }

  const results = search(graph, opts)

  if (args.json) {
    console.log(JSON.stringify(results.map(r => ({
      id:            r.entity['@id'],
      type:          r.entity['@type'],
      name:          r.entity.name,
      description:   r.entity.description,
      tags:          r.entity.tags,
      relationships: r.entity.relationships,
      score:         r.score,
      hops:          r.hops,
    })), null, 2))
  } else {
    formatHuman(results, opts)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { search }
