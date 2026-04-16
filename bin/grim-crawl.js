#!/usr/bin/env node
'use strict'

/**
 * grim-crawl.js — The Crawl
 *
 * Descends into unstructured notes and surfaces structured knowledge.
 * Sends markdown files to Ollama (THE CRAWLER persona) for entity extraction,
 * deduplicates against existing graph, writes new entities, rebuilds index.
 *
 * Local only — requires direct KB write access.
 *
 * CLI:
 *   grim crawl --source diary/week-2026-04-14/
 *   grim crawl --source notes.md
 *   grim crawl --source diary/ --since 2026-04-01
 *   grim crawl --source diary/ --dry-run        Preview without writing
 */

const fs       = require('node:fs')
const path     = require('node:path')
const minimist = require('minimist')
const { ask }          = require('./model-ask')
const { loadGraph }    = require('../lib/graph')
const { writeEntity, findDuplicates } = require('../lib/entities')
const { scribe }       = require('./grim-scribe')
const { requireMode }  = require('../lib/env')

requireMode('local')

// ── THE CRAWLER system prompt ─────────────────────────────────────────────────

const CRAWLER_SYSTEM = `You are THE CRAWLER. You descend into unstructured text and return structured knowledge. Your output is always valid JSON — nothing else, no markdown, no commentary. Extract: people, projects, concepts (DefinedTerm), events, software systems (SoftwareApplication). Infer relationships between entities found in the same text. Do not hallucinate entities not present in the text. Return a JSON array of entity objects.`

const EXTRACTION_PROMPT = (content) => `Extract all entities from the following text. For each entity return:
- "@type": "Person" | "Project" | "DefinedTerm" | "Event" | "SoftwareApplication"
- "@id": "{type_prefix}_{slug}" (lowercase, underscores, e.g. person_jane_smith)
- "name": display name
- "description": one clear sentence
- "tags": array like ["type/person", "domain/workflow"]
- "relationships": object of typed edges to other entities in THIS text only

Return ONLY a valid JSON array. No markdown. No preamble.

TEXT:
${content}`

// ── File discovery ────────────────────────────────────────────────────────────

function collectMarkdown(source, since = null) {
  const files = []
  const stat  = fs.statSync(source)

  if (stat.isFile()) {
    if (source.endsWith('.md') || source.endsWith('.txt')) files.push(source)
    return files
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const full = path.join(source, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMarkdown(full, since))
    } else if (/\.(md|txt|markdown)$/.test(entry.name)) {
      if (since) {
        const mtime = fs.statSync(full).mtime
        if (mtime < new Date(since)) continue
      }
      files.push(full)
    }
  }
  return files
}

// ── Extract entities from one file ───────────────────────────────────────────

async function extractFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  if (content.trim().length < 20) return []

  const raw = await ask({
    prompt: EXTRACTION_PROMPT(content),
    system: CRAWLER_SYSTEM,
    task:   'extraction',
    json:   true,
  })

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Strip any markdown fences the model snuck in
    const stripped = raw
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()
    try {
      const parsed = JSON.parse(stripped)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      console.error(`  ✗ Could not parse extraction output for ${path.basename(filePath)}`)
      return []
    }
  }
}

// ── Main crawl ────────────────────────────────────────────────────────────────

async function crawl({ source, since, dryRun = false, verbose = false }) {
  const files = collectMarkdown(source, since)
  if (!files.length) {
    console.log('  No markdown files found.')
    return { filesProcessed: 0, entitiesFound: 0, entitiesCreated: 0, skipped: 0 }
  }

  console.log(`\n  THE CRAWLER descends. (${files.length} file${files.length === 1 ? '' : 's'})\n`)

  const graph = await loadGraph()
  let entitiesFound   = 0
  let entitiesCreated = 0
  let skipped         = 0

  for (const file of files) {
    const name = path.basename(file)
    process.stdout.write(`  → ${name} ... `)

    const entities = await extractFromFile(file)
    entitiesFound += entities.length

    if (!entities.length) {
      console.log('nothing found')
      continue
    }

    console.log(`${entities.length} entities`)

    for (const entity of entities) {
      if (!entity['@type'] || !entity.name) {
        if (verbose) console.log(`     ✗ Skipped (missing type/name): ${JSON.stringify(entity).slice(0, 60)}`)
        skipped++
        continue
      }

      const dupes = findDuplicates(entity, graph)
      if (dupes.length && dupes[0].score >= 95) {
        if (verbose) console.log(`     ~ Duplicate: ${entity.name} → ${dupes[0].id}`)
        skipped++
        continue
      }

      entity.metadata = { source: `crawl:${path.basename(file)}` }

      if (!dryRun) {
        try {
          const result = writeEntity(entity, graph)
          if (result.created) {
            entitiesCreated++
            if (verbose) console.log(`     ✓ Created: ${result.id}`)
          } else {
            skipped++
          }
        } catch (e) {
          console.error(`     ✗ Failed to write ${entity.name}: ${e.message}`)
          skipped++
        }
      } else {
        console.log(`     [dry-run] Would create: ${entity['@id'] || entity.name} (${entity['@type']})`)
        entitiesCreated++
      }
    }
  }

  if (!dryRun && entitiesCreated > 0) {
    process.stdout.write('\n  Running The Scribe...')
    scribe()
    console.log(' done.')
  }

  return { filesProcessed: files.length, entitiesFound, entitiesCreated, skipped }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['dry-run', 'json', 'verbose'],
    alias:   { j: 'json', v: 'verbose', n: 'dry-run' },
    string:  ['source', 'since'],
  })

  const source = args.source || args._[0]
  if (!source) {
    console.error('Usage: grim crawl --source <path> [--since YYYY-MM-DD] [--dry-run]')
    process.exit(1)
  }

  if (!fs.existsSync(source)) {
    console.error(`Source not found: ${source}`)
    process.exit(1)
  }

  const stats = await crawl({
    source,
    since:   args.since,
    dryRun:  args['dry-run'],
    verbose: args.verbose,
  })

  if (args.json) {
    console.log(JSON.stringify(stats, null, 2))
  } else {
    console.log(`\n  The Crawl is complete.`)
    console.log(`  Files     : ${stats.filesProcessed}`)
    console.log(`  Found     : ${stats.entitiesFound}`)
    console.log(`  Created   : ${stats.entitiesCreated}`)
    console.log(`  Skipped   : ${stats.skipped}`)
    console.log()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { crawl }
