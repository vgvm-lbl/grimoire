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
const { requireMode, config, isLocal } = require('../lib/env')
const { TAGS, suggestTags } = require('../lib/tags')
const { semanticSearch, indexReady } = require('../lib/vectors')
const { relTargetId, resolveTarget, fmtBounds, filterActive, isActive } = require('../lib/temporal')

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search the graph.
 * @param {object} graph
 * @param {object} opts
 * @param {string}  [opts.query]         - free-text search
 * @param {string}  [opts.tag]           - exact tag filter
 * @param {string}  [opts.type]          - @type filter
 * @param {number}  [opts.depth]         - relationship traversal depth (default 0)
 * @param {number}  [opts.limit]         - max results (default 20)
 * @param {Array}   [opts.semanticHits]  - pre-computed vector hits to merge in
 * @param {boolean} [opts.active]        - if true, filter traversal to active edges only
 * @param {string}  [opts.asOf]          - ISO date for active filter (default: today)
 * @returns {Array<{entity, score, hops}>}
 */
function search(graph, { query, tag, type, depth = 0, limit = 20, semanticHits = [], active = false, asOf } = {}) {
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
    const q      = query.toLowerCase().trim()
    const tokens = q.split(/\s+/).filter(Boolean)

    // Exact name index lookup — full phrase, score 100
    const exactId = graph.index[q]
    if (exactId && graph.entities[exactId]) {
      results.set(exactId, { entity: graph.entities[exactId], score: 100, hops: 0 })
    }

    for (const [id, entity] of Object.entries(graph.entities)) {
      const name  = (entity.name        || '').toLowerCase()
      const desc  = (entity.description || '').toLowerCase()
      const notes = (Array.isArray(entity.notes) ? entity.notes.join(' ') : '').toLowerCase()
      const eid   = id.toLowerCase()
      const tags  = (entity.tags || []).join(' ').toLowerCase()
      const blob  = `${name} ${desc} ${notes} ${eid} ${tags}`

      let score = results.get(id)?.score ?? 0

      // ── Full-phrase matches (high confidence) ──────────────────────────────
      if (!score) {
        if      (name === q || eid === q)  score = Math.max(score, 100)
        else if (name.startsWith(q))       score = Math.max(score, 80)
        else if (name.includes(q))         score = Math.max(score, 60)
        else if (desc.includes(q))         score = Math.max(score, 40)
        else if (eid.includes(q))          score = Math.max(score, 30)
        else if (tags.includes(q))         score = Math.max(score, 25)
      }

      // ── Token-based scoring (multi-word queries) ───────────────────────────
      // Each token that matches contributes; reward entities that hit more tokens.
      if (tokens.length > 1) {
        let tokenHits = 0
        for (const tok of tokens) {
          if (name.includes(tok))       { tokenHits++; score = Math.max(score, 15) }
          else if (tags.includes(tok))  { tokenHits++; score = Math.max(score, 10) }
          else if (desc.includes(tok))  { tokenHits++; score = Math.max(score,  8) }
          else if (blob.includes(tok))  { tokenHits++; score = Math.max(score,  5) }
        }
        // Bonus for matching multiple tokens — scales up to full-phrase score
        if (tokenHits > 1) {
          score += Math.round((tokenHits / tokens.length) * 20)
        } else if (tokenHits === 0) {
          score = 0
        }
      }

      if (score > 0) results.set(id, { entity, score, hops: 0 })
    }

    // ── Merge semantic hits ──────────────────────────────────────────────────
    // Vector scores are cosine similarity 0–1; scale to 0–55 and blend in.
    for (const hit of semanticHits) {
      const entity = graph.entities[hit.id]
      if (!entity) continue
      const semScore = Math.round(hit.score * 55)
      const existing = results.get(hit.id)
      if (existing) {
        existing.score = Math.max(existing.score, semScore) + Math.round(semScore * 0.3)
      } else {
        results.set(hit.id, { entity, score: semScore, hops: 0 })
      }
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

        // Outgoing edges — targets may be strings or rich { id, validFrom, ... } objects
        for (const targets of Object.values(entity.relationships || {})) {
          const rawList = Array.isArray(targets) ? targets : [targets]
          const eligible = active ? filterActive(rawList, asOf) : rawList
          for (const raw of eligible) {
            const tid = relTargetId(raw)
            if (tid && !results.has(tid) && graph.entities[tid]) {
              results.set(tid, { entity: graph.entities[tid], score: Math.max(1, 50 - hop * 15), hops: hop })
              next.add(tid)
            }
          }
        }

        // Backlinks (incoming edges)
        for (const bid of (graph.backlinks[id] || [])) {
          if (!results.has(bid) && graph.entities[bid]) {
            if (active) {
              // Only follow if the back-entity has an active edge pointing to us
              const backEntity = graph.entities[bid]
              const hasActiveEdge = Object.values(backEntity.relationships || {}).some(targets => {
                const rawList = Array.isArray(targets) ? targets : [targets]
                return filterActive(rawList, asOf).some(t => relTargetId(t) === id)
              })
              if (!hasActiveEdge) continue
            }
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

// ── Context enrichment ────────────────────────────────────────────────────────
// Adds _context: { outgoing, incoming } to a result — names resolved, not just IDs.
// Used by MCP oracle_search so skills get concept+parent+children in one call.

function enrichWithContext(result, graph) {
  const entity = result.entity
  const id     = entity['@id']

  // Outgoing: all typed relationships this entity declares
  // Preserves temporal bounds (validFrom/validUntil) when present on rich edge objects
  const outgoing = {}
  for (const [relType, targets] of Object.entries(entity.relationships || {})) {
    const raw = Array.isArray(targets) ? targets : [targets]
    outgoing[relType] = raw
      .map(t => {
        const resolved = resolveTarget(t)
        if (!resolved) return null
        const e = graph.entities[resolved.id]
        const entry = { id: resolved.id, name: e?.name || resolved.id, type: e?.['@type'] || '?' }
        if (resolved.validFrom)     entry.validFrom     = resolved.validFrom
        if (resolved.validUntil)    entry.validUntil    = resolved.validUntil
        if (resolved.assertionType && resolved.assertionType !== 'explicit') entry.assertionType = resolved.assertionType
        return entry
      })
      .filter(Boolean)
  }

  // Incoming: entities that point TO this entity, with the rel type resolved
  const incoming = []
  for (const backId of (graph.backlinks[id] || [])) {
    const backEntity = graph.entities[backId]
    if (!backEntity) continue
    for (const [relType, targets] of Object.entries(backEntity.relationships || {})) {
      const raw = Array.isArray(targets) ? targets : [targets]
      const match = raw.find(t => relTargetId(t) === id)
      if (match) {
        const resolved = resolveTarget(match)
        const entry = { id: backId, name: backEntity.name || backId, type: backEntity['@type'] || '?', relType }
        if (resolved?.validFrom)  entry.validFrom  = resolved.validFrom
        if (resolved?.validUntil) entry.validUntil = resolved.validUntil
        incoming.push(entry)
      }
    }
  }

  result._context = { outgoing, incoming }
  return result
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

function formatHuman(results, { query, tag, type, depth, active, asOf }) {
  const qualifier  = query ? `"${query}"` : tag ? `tag:${tag}` : type ? `type:${type}` : '(all)'
  const depthNote  = depth > 0 ? ` (depth ${depth})` : ''
  const activeNote = active ? ` [active as of ${asOf || 'today'}]` : ''

  if (results.length === 0) {
    console.log(`\n  No results for ${qualifier}${activeNote}\n`)
    return
  }

  console.log(`\n  ${results.length} result${results.length === 1 ? '' : 's'} for ${qualifier}${depthNote}${activeNote}\n`)

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
    boolean: ['json', 'list-tags', 'list-types', 'list-ontology', 'suggest-tags', 'active'],
    alias:   { j: 'json', d: 'depth', t: 'tag', l: 'limit' },
    default: { depth: 0, limit: 20 }
  })

  // ── Ontology modes (no graph load needed) ─────────────────────────────────

  if (args['list-ontology']) {
    if (args.json) {
      console.log(JSON.stringify(TAGS, null, 2))
    } else {
      console.log('\n  Canonical tag ontology:\n')
      let lastNs = ''
      for (const [tag, desc] of Object.entries(TAGS)) {
        const ns = tag.split('/')[0]
        if (ns !== lastNs) { console.log(); lastNs = ns }
        console.log(`  ${tag.padEnd(32)}  ${desc}`)
      }
      console.log()
    }
    return
  }

  if (args['suggest-tags']) {
    const q = args._.join(' ').trim()
    if (!q) { console.error('Usage: grim oracle --suggest-tags <query>'); process.exit(1) }
    const suggestions = suggestTags(q)
    if (args.json) {
      console.log(JSON.stringify(suggestions, null, 2))
    } else {
      console.log(`\n  Suggested tags for "${q}":\n`)
      for (const tag of suggestions) console.log(`  ${tag.padEnd(32)}  ${TAGS[tag]}`)
      console.log()
    }
    return
  }

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
    tag:    args.tag    || null,
    type:   args.type   || null,
    depth:  Number(args.depth),
    limit:  Number(args.limit),
    active: args.active || false,
    asOf:   args['as-of'] || undefined,
  }

  if (!opts.query && !opts.tag && !opts.type) {
    console.error('Usage: grim oracle <query>')
    console.error('       grim oracle --tag <tag>')
    console.error('       grim oracle --type <type>')
    console.error('       grim oracle --list-tags')
    console.error('       grim oracle --list-types')
    console.error('       grim oracle <query> --depth 2 --active           (active edges only)')
    console.error('       grim oracle <query> --depth 2 --active --as-of 2023-01-01')
    process.exit(1)
  }

  // Semantic search — local only (needs vector index on disk), runs alongside keyword
  if (opts.query && isLocal && !args['no-semantic']) {
    try {
      if (await indexReady()) {
        opts.semanticHits = await semanticSearch(opts.query, opts.limit * 2)
      }
    } catch { /* degraded gracefully — keyword only */ }
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

module.exports = { search, enrichWithContext }

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
