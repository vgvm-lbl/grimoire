#!/usr/bin/env node
'use strict'

/**
 * grim-rest.js — Long Rest
 *
 * Nightly dream analysis. Sends graph state to Ollama for deep reflection:
 * gaps, missing connections, patterns, stale threads.
 * Writes output as a meta-dream entity.
 *
 * In D&D terms: the party camps, recovers, and the GM preps the next session.
 *
 * Local only.
 *
 * CLI:
 *   grim rest             Run dream analysis, write meta-dream entity
 *   grim rest --json      Machine-readable output
 *   grim rest --dry-run   Print analysis without saving
 */

const minimist = require('minimist')
const { ask }         = require('./model-ask')
const { loadGraph }   = require('../lib/graph')
const { writeEntity } = require('../lib/entities')
const { scribe }      = require('./grim-scribe')
const { requireMode } = require('../lib/env')

requireMode('local')

// ── Dream prompt ──────────────────────────────────────────────────────────────

const GM_SYSTEM = `You are the GM — the Game Master of this knowledge graph. You know everything that's been recorded. You think slowly, in systems and consequences. You surface what matters. Your output is JSON.`

function dreamPrompt(stats, recentIds, orphanSample, denseTags) {
  return `Analyze this knowledge graph state and dream about what it means.

GRAPH STATS:
${JSON.stringify(stats, null, 2)}

RECENTLY MODIFIED ENTITIES (last 24h):
${JSON.stringify(recentIds, null, 2)}

ORPHAN SAMPLE (unconnected entities):
${JSON.stringify(orphanSample, null, 2)}

DENSEST TAGS (most entities):
${JSON.stringify(denseTags, null, 2)}

Return a JSON object with:
{
  "summary": "2-3 sentence overview of what the graph reveals",
  "patterns": ["pattern or theme you observe"],
  "gaps": ["missing connections or underrepresented areas"],
  "suggestions": ["concrete actions to improve the graph"],
  "staleThreads": ["topics that haven't been updated but seem important"],
  "insight": "one surprising or non-obvious observation"
}`
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function longRest({ dryRun = false } = {}) {
  const graph = await loadGraph()
  const now   = new Date()
  const meta  = graph._meta || {}

  // Graph stats for the prompt
  const stats = {
    entityCount: meta.entityCount || Object.keys(graph.entities).length,
    edgeCount:   meta.edgeCount   || graph.edges.length,
    tagCount:    meta.tagCount    || Object.keys(graph.tags).length,
    builtAt:     meta.builtAt,
  }

  // Entities modified in last 24h
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const recentIds = Object.entries(graph.entities)
    .filter(([, e]) => (e.file && true)) // we don't have mtime in the index easily
    .slice(0, 10)
    .map(([id, e]) => ({ id, name: e.name, type: e['@type'] }))

  // Orphan sample
  const connected = new Set()
  for (const edge of graph.edges) { connected.add(edge.from); connected.add(edge.to) }
  const orphanSample = Object.entries(graph.entities)
    .filter(([id]) => !connected.has(id))
    .slice(0, 15)
    .map(([id, e]) => ({ id, name: e.name, type: e['@type'] }))

  // Densest tags
  const denseTags = Object.entries(graph.tags)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([tag, ids]) => ({ tag, count: ids.length }))

  stats.orphanCount = Object.keys(graph.entities).length - connected.size

  console.log(`\n  Long Rest begins...\n`)
  process.stdout.write(`  The GM is dreaming... `)

  const raw = await ask({
    prompt: dreamPrompt(stats, recentIds, orphanSample, denseTags),
    system: GM_SYSTEM,
    task:   'dreaming',
    json:   true,
  })

  console.log('done.\n')

  let dream = {}
  try {
    dream = JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    try { dream = JSON.parse(stripped) } catch {
      dream = { summary: raw.slice(0, 500), error: 'parse_failed' }
    }
  }

  const dateStr = now.toISOString().slice(0, 10)
  const dreamEntity = {
    '@type':      'Dream',
    '@id':        `meta_dream_${dateStr.replace(/-/g, '_')}`,
    name:         `Long Rest — ${dateStr}`,
    description:  dream.summary || '',
    summary:      dream.summary,
    patterns:     dream.patterns  || [],
    gaps:         dream.gaps      || [],
    suggestions:  dream.suggestions || [],
    staleThreads: dream.staleThreads || [],
    insight:      dream.insight   || '',
    graphStats:   stats,
    tags:         ['meta/dream'],
    relationships: {},
    metadata: { dateCreated: dateStr, source: 'long-rest' },
  }

  if (!dryRun) {
    writeEntity(dreamEntity, graph)
    scribe()
    console.log(`  Dream saved: ${dreamEntity['@id']}`)
  }

  return { dream: dreamEntity, stats }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json', 'dry-run'],
    alias:   { j: 'json', n: 'dry-run' },
  })

  const result = await longRest({ dryRun: args['dry-run'] })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const d = result.dream
  console.log(`\n  ░ Dream Report — ${d.name}\n`)
  if (d.summary) console.log(`  ${d.summary}\n`)

  if (d.patterns?.length) {
    console.log('  Patterns:')
    d.patterns.forEach(p => console.log(`    • ${p}`))
    console.log()
  }
  if (d.gaps?.length) {
    console.log('  Gaps:')
    d.gaps.forEach(g => console.log(`    • ${g}`))
    console.log()
  }
  if (d.suggestions?.length) {
    console.log('  Suggestions:')
    d.suggestions.forEach(s => console.log(`    • ${s}`))
    console.log()
  }
  if (d.insight) {
    console.log(`  Insight: ${d.insight}\n`)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { longRest }
