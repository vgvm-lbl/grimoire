#!/usr/bin/env node
'use strict'

/**
 * grim-pathfind.js — Pathfinder
 *
 * Finds orphan entities (zero edges) and infers relationships using Ollama.
 * The highest-ROI maintenance task — can turn thousands of isolated nodes
 * into a connected graph overnight.
 *
 * CRITICAL: Modifies entity JSON files using JSON.parse/stringify only.
 * NEVER appends markdown text to .json files.
 *
 * Local only — requires direct KB write access.
 *
 * CLI:
 *   grim pathfind                    Process up to 20 orphans
 *   grim pathfind --batch 50         Larger batch
 *   grim pathfind --dry-run          Preview relationships without applying
 *   grim pathfind --json             Machine-readable output
 */

const minimist = require('minimist')
const { ask }         = require('./model-ask')
const { loadGraph, loadEntity, saveEntity } = require('../lib/graph')
const { scribe }      = require('./grim-scribe')
const { requireMode } = require('../lib/env')
const { extractRelations, nerAvailable } = require('../lib/ner-client')

requireMode('local')

// ── Prompt ───────────────────────────────────────────────────────────────────

const PATHFINDER_SYSTEM = `You are the Pathfinder. You find connections between isolated entities in a knowledge graph. Your output is always valid JSON. No markdown, no preamble.`

function pathfindPrompt(orphans, context) {
  return `Given these ORPHAN entities (currently unconnected):
${JSON.stringify(orphans, null, 2)}

And these CONTEXT entities (already in the graph):
${JSON.stringify(context, null, 2)}

Suggest relationship edges that would connect the orphans to the graph.
Return ONLY a JSON array of suggested edges. Each edge:
{
  "from": "<entity @id>",
  "to": "<entity @id>",
  "type": "<relationship type>",
  "reason": "<one sentence why>"
}

Valid relationship types: works_on, manages, collaborates_with, depends_on, part_of, related_to, mentioned_in, defines, aspect_of, uses, created_by

Only suggest edges you are confident about. Do not hallucinate connections.`
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function rebelEnrichOrphans(orphanData, graph) {
  const enriched = []
  for (const o of orphanData) {
    const text = [o.name, o.description].filter(Boolean).join('. ')
    if (!text || text.length < 10) { enriched.push(o); continue }
    const triples = await extractRelations(text)
    if (triples.length) {
      enriched.push({ ...o, rebel_triples: triples })
    } else {
      enriched.push(o)
    }
  }
  return enriched
}

async function pathfind({ batchSize = 20, dryRun = false, verbose = false, noNer = false } = {}) {
  const graph = await loadGraph()

  // Find orphans
  const connected = new Set()
  for (const edge of graph.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }

  const orphanIds = Object.keys(graph.entities).filter(id => !connected.has(id))

  if (!orphanIds.length) {
    return { orphanCount: 0, processed: 0, edgesAdded: 0, message: 'No orphans found.' }
  }

  console.log(`\n  Pathfinder online. ${orphanIds.length} orphans detected.\n`)

  // Take a batch of orphans
  const batch = orphanIds.slice(0, batchSize)

  // Gather context — a sample of well-connected entities
  const contextIds = Object.keys(graph.entities)
    .filter(id => connected.has(id))
    .slice(0, 30)

  let orphanData = batch.map(id => ({
    '@id': id, '@type': graph.entities[id]['@type'], name: graph.entities[id].name,
    description: graph.entities[id].description, tags: graph.entities[id].tags,
  }))

  // Enrich orphans with Rebel relation triples when NER service is available
  if (!noNer && await nerAvailable()) {
    if (verbose) console.log('  Rebel enriching orphans...')
    orphanData = await rebelEnrichOrphans(orphanData, graph)
  }

  const contextData = contextIds.map(id => ({
    '@id': id, '@type': graph.entities[id]['@type'], name: graph.entities[id].name,
    description: (graph.entities[id].description || '').slice(0, 100),
  }))

  process.stdout.write(`  Asking Pathfinder to map ${batch.length} orphans...`)

  const raw = await ask({
    prompt: pathfindPrompt(orphanData, contextData),
    system: PATHFINDER_SYSTEM,
    task:   'linking',
    json:   true,
  })

  console.log(' done.')

  let suggestions = []
  try {
    suggestions = JSON.parse(raw)
    if (!Array.isArray(suggestions)) suggestions = []
  } catch {
    const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    try { suggestions = JSON.parse(stripped) } catch { suggestions = [] }
  }

  console.log(`  ${suggestions.length} relationships suggested.\n`)

  let edgesAdded = 0
  const applied  = []
  const skipped  = []

  for (const edge of suggestions) {
    const { from, to, type, reason } = edge
    if (!from || !to || !type) { skipped.push({ edge, reason: 'missing fields' }); continue }
    if (!graph.entities[from]) { skipped.push({ edge, reason: `unknown 'from': ${from}` }); continue }
    if (!graph.entities[to])   { skipped.push({ edge, reason: `unknown 'to': ${to}` });   continue }

    if (verbose) console.log(`  + ${from} → ${type} → ${to}`)
    if (verbose && reason) console.log(`    reason: ${reason}`)

    if (!dryRun) {
      try {
        // ALWAYS use JSON parse/modify/stringify — never append text to .json files
        const entity = loadEntity(from, graph)
        entity.relationships = entity.relationships || {}

        const existing = entity.relationships[type]
        if (Array.isArray(existing)) {
          if (!existing.includes(to)) existing.push(to)
        } else if (existing) {
          if (existing !== to) entity.relationships[type] = [existing, to]
        } else {
          entity.relationships[type] = [to]
        }

        saveEntity(from, entity, graph)
        edgesAdded++
        applied.push(edge)
      } catch (e) {
        console.error(`  ✗ Failed to apply edge ${from}→${to}: ${e.message}`)
        skipped.push({ edge, reason: e.message })
      }
    } else {
      console.log(`  [dry-run] ${from} → ${type} → ${to}`)
      edgesAdded++
      applied.push(edge)
    }
  }

  if (!dryRun && edgesAdded > 0) {
    process.stdout.write('\n  Running The Scribe...')
    scribe()
    console.log(' done.')
  }

  return {
    orphanCount:    orphanIds.length,
    processed:      batch.length,
    suggested:      suggestions.length,
    edgesAdded,
    skippedCount:   skipped.length,
    applied,
    skipped: verbose ? skipped : undefined,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['dry-run', 'json', 'verbose', 'no-ner'],
    alias:   { j: 'json', v: 'verbose', n: 'dry-run', b: 'batch' },
    default: { batch: 20 },
  })

  const result = await pathfind({
    batchSize: Number(args.batch),
    dryRun:    args['dry-run'],
    verbose:   args.verbose,
    noNer:     args['no-ner'],
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.orphanCount === 0) {
    console.log(`\n  Pathfinder: no orphans. Graph is fully connected.\n`)
  } else {
    console.log(`\n  Pathfinder complete.`)
    console.log(`  Orphans total : ${result.orphanCount}`)
    console.log(`  Processed     : ${result.processed}`)
    console.log(`  Edges added   : ${result.edgesAdded}`)
    if (result.skippedCount) console.log(`  Skipped       : ${result.skippedCount}`)
    console.log()
  }
}

module.exports = { pathfind }

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1) })
