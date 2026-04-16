#!/usr/bin/env node
'use strict'

/**
 * grim-divine.js — Divination
 *
 * Computes a health score for the knowledge graph and reports issues.
 * Works in local mode (full checks) or remote mode (stats only via server).
 *
 * Health score formula:
 *   100
 *   - (broken_edges   / total_edges)    * 30
 *   - (orphans        / total_entities) * 30
 *   - (missing_fields / total_entities) * 20
 *   - (id_mismatches  / total_entities) * 10  [local only]
 *   - (empty_entities / total_entities) * 10
 *
 * Grade: A≥90 B≥80 C≥70 D≥60 F<60
 *
 * CLI:
 *   grim divine                  Full health report
 *   grim divine --json           Machine-readable
 *   grim divine --check orphans  Single check
 *   grim divine --fix            Auto-fix filename mismatches [local only]
 */

const fs       = require('node:fs')
const path     = require('node:path')
const minimist = require('minimist')
const { loadGraph } = require('../lib/graph')
const { config, isLocal, requireMode } = require('../lib/env')

// ── Checks ───────────────────────────────────────────────────────────────────

function runChecks(graph, { check = null, fix = false } = {}) {
  const entities   = graph.entities  || {}
  const edges      = graph.edges     || []
  const entityIds  = new Set(Object.keys(entities))

  const results = {
    entityCount:   entityIds.size,
    edgeCount:     edges.length,
    brokenEdges:   [],
    orphans:       [],
    missingFields: [],
    idMismatches:  [],
    emptyEntities: [],
  }

  // ── Broken edges ─────────────────────────────────────────────────────────
  if (!check || check === 'edges') {
    for (const edge of edges) {
      if (!entityIds.has(edge.to)) {
        results.brokenEdges.push(edge)
      }
    }
  }

  // ── Orphans (zero edges in or out) ────────────────────────────────────────
  if (!check || check === 'orphans') {
    const connected = new Set()
    for (const edge of edges) {
      connected.add(edge.from)
      connected.add(edge.to)
    }
    for (const id of entityIds) {
      if (!connected.has(id)) results.orphans.push(id)
    }
  }

  // ── Missing required fields ───────────────────────────────────────────────
  if (!check || check === 'fields') {
    for (const [id, entity] of Object.entries(entities)) {
      const missing = []
      if (!entity['@type'])  missing.push('@type')
      if (!entity['@id'])    missing.push('@id')
      if (!entity.name)      missing.push('name')
      if (missing.length) results.missingFields.push({ id, missing })
    }
  }

  // ── Empty / stub entities ─────────────────────────────────────────────────
  if (!check || check === 'empty') {
    for (const [id, entity] of Object.entries(entities)) {
      if (!entity.description || entity.description.trim().length < 5) {
        results.emptyEntities.push(id)
      }
    }
  }

  // ── Filename / ID mismatches (local only) ─────────────────────────────────
  if (isLocal && (!check || check === 'files')) {
    for (const [id, entity] of Object.entries(entities)) {
      const expectedFile = id.replace(/_/g, '-') + '.json'
      const actualFile   = path.basename(entity.file || '')
      if (actualFile && actualFile !== expectedFile) {
        results.idMismatches.push({ id, expected: expectedFile, actual: actualFile })
      }
    }
  }

  return results
}

function computeScore(r) {
  let score = 100
  if (r.edgeCount > 0)     score -= (r.brokenEdges.length   / r.edgeCount)    * 30
  if (r.entityCount > 0) {
    score -= (r.orphans.length       / r.entityCount) * 30
    score -= (r.missingFields.length / r.entityCount) * 20
    score -= (r.idMismatches.length  / r.entityCount) * 10
    score -= (r.emptyEntities.length / r.entityCount) * 10
  }
  score = Math.max(0, Math.round(score))
  const grade   = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
  const density = r.entityCount > 0
    ? Math.round((r.edgeCount / r.entityCount) * 100)
    : 0
  return { score, grade, density }
}

// ── Formatting ────────────────────────────────────────────────────────────────

const GRADE_COLOR = { A: '✨', B: '✅', C: '⚠️ ', D: '🔶', F: '🔴' }

function formatHuman(r, { score, grade, density }) {
  console.log(`\n  Divination — Knowledge Graph Health\n`)
  console.log(`  ${GRADE_COLOR[grade]} Score  : ${score}/100  (${grade})`)
  console.log(`     Entities : ${r.entityCount}`)
  console.log(`     Edges    : ${r.edgeCount}  (density ${density}%)`)
  console.log()

  const section = (label, items, render) => {
    if (items.length === 0) {
      console.log(`  ✓  ${label}: none`)
    } else {
      console.log(`  ✗  ${label}: ${items.length}`)
      items.slice(0, 10).forEach(i => console.log(`       ${render(i)}`))
      if (items.length > 10) console.log(`       … and ${items.length - 10} more`)
    }
  }

  console.log()
  section('Broken edges',    r.brokenEdges,   e => `${e.from} → ${e.to} (${e.type})`)
  section('Orphan entities', r.orphans,        id => id)
  section('Missing fields',  r.missingFields,  m => `${m.id}: ${m.missing.join(', ')}`)
  section('Empty entities',  r.emptyEntities,  id => id)
  if (isLocal) {
    section('ID/file mismatches', r.idMismatches, m => `${m.id}: expected ${m.expected}, got ${m.actual}`)
  }
  console.log()
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json', 'fix'],
    alias:   { j: 'json' },
    string:  ['check'],
  })

  requireMode('any')
  const graph   = await loadGraph()
  const results = runChecks(graph, { check: args.check, fix: args.fix })
  const scoring = computeScore(results)

  if (args.json) {
    console.log(JSON.stringify({ ...results, ...scoring }, null, 2))
    return
  }

  formatHuman(results, scoring)
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { runChecks, computeScore }
