#!/usr/bin/env node
'use strict'

/**
 * grim-ritual.js — The Ritual
 *
 * Nightly maintenance pipeline. Runs automatically via cron on aid.
 * Each stage logs structured JSON results to the KB logs directory.
 *
 * Pipeline:
 *   1. Long Rest    — dream analysis, surface gaps and patterns
 *   2. Scribe       — rebuild graph index
 *   3. Divination   — compute health score
 *   4. Pathfinder   — link orphan entities (batch 20)
 *   5. Scribe again — incorporate new edges
 *   6. Noise Floor  — post ritual summary as thought
 *
 * Local only — must run on aid.
 *
 * CLI:
 *   node bin/grim-ritual.js
 *   node bin/grim-ritual.js --skip-rest      Skip Long Rest (faster, no Ollama)
 *   node bin/grim-ritual.js --skip-pathfind  Skip Pathfinder
 *   node bin/grim-ritual.js --batch 50       Pathfinder batch size
 *   node bin/grim-ritual.js --json           Machine-readable stage log
 */

const fs        = require('node:fs')
const path      = require('node:path')
const minimist  = require('minimist')
const { config, requireMode } = require('../lib/env')

requireMode('local')

const LOGS_DIR = path.join(config.root, 'logs')
fs.mkdirSync(LOGS_DIR, { recursive: true })

// ── Stage runner ──────────────────────────────────────────────────────────────

async function runStage(name, fn) {
  const started = Date.now()
  process.stdout.write(`  [${new Date().toISOString().slice(11, 19)}] ${name} ... `)
  try {
    const result  = await fn()
    const elapsed = Date.now() - started
    console.log(`done (${elapsed}ms)`)
    return { stage: name, ok: true, elapsed, result }
  } catch (e) {
    const elapsed = Date.now() - started
    console.log(`FAILED (${e.message})`)
    return { stage: name, ok: false, elapsed, error: e.message }
  }
}

// ── Noise Floor poster ────────────────────────────────────────────────────────

function postToNoiseFloor(thought) {
  const noiseFile = path.join(config.root, 'noise-floor.json')
  let thoughts = []
  try { thoughts = JSON.parse(fs.readFileSync(noiseFile, 'utf8')) } catch {}
  thoughts.push({ at: new Date().toISOString(), source: 'ritual', type: 'observation', text: thought })
  fs.writeFileSync(noiseFile, JSON.stringify(thoughts.slice(-500), null, 2))
}

// ── Main ritual ───────────────────────────────────────────────────────────────

async function runRitual({ skipRest = false, skipPathfind = false, batchSize = 20 } = {}) {
  const date    = new Date().toISOString().slice(0, 10)
  const logFile = path.join(LOGS_DIR, `ritual-${date}.json`)
  const stages  = []

  console.log(`\n  ░ The Ritual begins — ${new Date().toISOString()}\n`)

  // Stage 1: Long Rest
  if (!skipRest) {
    const stage = await runStage('Long Rest', async () => {
      const { longRest } = require('./grim-rest')
      return await longRest()
    })
    stages.push(stage)
  } else {
    console.log(`  [--] Long Rest skipped`)
  }

  // Stage 2: Scribe
  stages.push(await runStage('Scribe', async () => {
    const { scribe } = require('./grim-scribe')
    const { graph }  = scribe()
    return { entityCount: graph._meta.entityCount, edgeCount: graph._meta.edgeCount }
  }))

  // Stage 3: Divination
  const divineStage = await runStage('Divination', async () => {
    const { loadGraph }            = require('../lib/graph')
    const { runChecks, computeScore } = require('./grim-divine')
    const graph   = await loadGraph()
    const results = runChecks(graph)
    const scoring = computeScore(results)
    return {
      score:       scoring.score,
      grade:       scoring.grade,
      density:     scoring.density,
      orphans:     results.orphans.length,
      brokenEdges: results.brokenEdges.length,
    }
  })
  stages.push(divineStage)

  // Stage 4: Pathfinder
  if (!skipPathfind) {
    stages.push(await runStage('Pathfinder', async () => {
      const { pathfind } = require('./grim-pathfind')
      return await pathfind({ batchSize })
    }))
  } else {
    console.log(`  [--] Pathfinder skipped`)
  }

  // Stage 5: Final Scribe
  stages.push(await runStage('Scribe (final)', async () => {
    const { scribe } = require('./grim-scribe')
    const { graph }  = scribe()
    return { entityCount: graph._meta.entityCount, edgeCount: graph._meta.edgeCount }
  }))

  // Summary
  const health  = divineStage.result
  const failed  = stages.filter(s => !s.ok)
  const summary = [
    `Ritual complete ${date}.`,
    health ? `Graph health: ${health.score}/100 (${health.grade}). Orphans: ${health.orphans}.` : null,
    failed.length ? `Failures: ${failed.map(s => s.stage).join(', ')}.` : 'All stages passed.',
  ].filter(Boolean)

  const log = {
    date,
    startedAt:  stages[0]?.result ? new Date().toISOString() : null,
    completedAt: new Date().toISOString(),
    stages,
    summary,
  }

  fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
  postToNoiseFloor(summary.join(' '))

  console.log(`\n  ░ Ritual complete.\n`)
  console.log(`  ${summary.join('\n  ')}\n`)
  console.log(`  Log: ${logFile}\n`)

  return log
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json', 'skip-rest', 'skip-pathfind'],
    alias:   { j: 'json', b: 'batch' },
    default: { batch: 20 },
  })

  const result = await runRitual({
    skipRest:     args['skip-rest'],
    skipPathfind: args['skip-pathfind'],
    batchSize:    Number(args.batch),
  })

  if (args.json) console.log(JSON.stringify(result, null, 2))
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { runRitual }
