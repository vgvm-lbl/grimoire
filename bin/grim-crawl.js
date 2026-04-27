#!/usr/bin/env node
'use strict'

/**
 * grim-crawl.js — The Crawl
 *
 * Descends into unstructured notes and source code, surfaces structured knowledge.
 * Sends text/code to Ollama (THE CRAWLER persona) for entity extraction,
 * deduplicates against existing graph, writes new entities, rebuilds index.
 *
 * Local only — requires direct KB write access.
 * crawlText() is exported for use by grim-server.js (POST /api/crawl).
 *
 * CLI:
 *   grim crawl --source diary/week-2026-04-14/
 *   grim crawl --source notes.md
 *   grim crawl --source src/foo.js
 *   grim crawl --source diary/ --since 2026-04-01
 *   grim crawl --source diary/ --dry-run        Preview without writing
 */

const fs       = require('node:fs')
const path     = require('node:path')
const minimist = require('minimist')
const nlp      = require('compromise')
const axios = require('axios')
const { ask }          = require('./model-ask')
const { loadGraph }    = require('../lib/graph')
const { writeEntity, findDuplicates } = require('../lib/entities')
const { scribe }       = require('./grim-scribe')
const { config, isLocal, isRemote } = require('../lib/env')
const { extractEntities, nerAvailable } = require('../lib/ner-client')
const { enqueue, loadQueue, updateEntry, clearSynced, QUEUE_FILE } = require('../lib/queue')

// ── Language detection ────────────────────────────────────────────────────────

const CODE_LANGUAGES = new Set(['javascript', 'python', 'bash', 'java'])

const EXT_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'javascript',
  '.py': 'python',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.java': 'java',
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text',
}

function detectLanguage(source = '', content = '') {
  const ext = path.extname(source).toLowerCase()
  if (EXT_MAP[ext]) return EXT_MAP[ext]
  const head = content.slice(0, 200)
  if (/^\s*#!.*python/.test(head))          return 'python'
  if (/^\s*#!.*\b(bash|sh|zsh)\b/.test(head)) return 'bash'
  if (/^\s*#!.*node/.test(head))            return 'javascript'
  if (/^\s*(public\s+class|import\s+java\.|package\s+\w)/.test(content)) return 'java'
  if (/^\s*(const|let|var|require\(|module\.exports|import\s+\{)/.test(content)) return 'javascript'
  if (/^\s*(def |import |from .+ import|class .+:)/.test(content)) return 'python'
  return 'text'
}

// ── THE CRAWLER system prompts ────────────────────────────────────────────────

const CRAWLER_SYSTEM = `You are THE CRAWLER. You descend into unstructured text and return structured knowledge. Your output is always valid JSON — nothing else, no markdown, no commentary. Extract: people, projects, concepts (DefinedTerm), events, software systems (SoftwareApplication). Infer relationships between entities found in the same text. Do not hallucinate entities not present in the text. Return a JSON array of entity objects.`

const CODE_CRAWLER_SYSTEM = `You are THE CRAWLER — source code edition. You read code and extract structured knowledge: what exists, what it means, where it has leverage, and where it wants to grow. Output is always valid JSON — nothing else, no markdown, no prose.

Extract entities across four dimensions:
1. COMPONENTS: classes, modules, services, exported functions, CLI tools → SoftwareApplication
2. CONCEPTS: algorithms, patterns, domain vocabulary, architectural decisions baked into the code → DefinedTerm
3. LEVERAGE POINTS: specific sites where a small change produces outsized effect (a routing table, a model assignment, a prompt template, a dispatch function, a config value) → DefinedTerm with tag "meta/leverage-point"
4. EXPANSION VECTORS: what this code is structurally ready to become with modest effort — adjacent capabilities requiring minimal new infrastructure → DefinedTerm with tag "meta/expansion-vector"

Be specific. "Uses strategy pattern" is weak. "Route table in model-ask.js maps task names to Ollama models — adding a new task requires one line" is strong. Root every description in THIS code, not generalities.`

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

const CODE_EXTRACTION_PROMPT = (content, language) => `Analyze this ${language} source code. Extract entities across four dimensions:

1. COMPONENTS (SoftwareApplication): modules, classes, major exported functions, CLI interfaces, services
2. CONCEPTS (DefinedTerm): algorithms, design patterns, domain vocabulary, key architectural decisions
3. LEVERAGE POINTS (DefinedTerm): specific sites where small edits have large effect — name the exact variable, function, or structure and explain the leverage. Tag these "meta/leverage-point".
4. EXPANSION VECTORS (DefinedTerm): what this code is structurally ready to become — concrete adjacent capabilities with minimal new infrastructure needed. Tag these "meta/expansion-vector".

For each entity return:
- "@type": "SoftwareApplication" | "DefinedTerm"
- "@id": snake_case like "softwareapplication_model_ask" or "definedterm_task_routing_table"
- "name": concise display name
- "description": one specific sentence rooted in THIS code — not generic
- "tags": type tag + domain tags + "meta/leverage-point" or "meta/expansion-vector" where applicable
- "relationships": typed edges to other entities found in THIS file only

Return ONLY a valid JSON array. No markdown. No preamble.

${language.toUpperCase()} SOURCE:
${content}`

// ── File discovery ────────────────────────────────────────────────────────────

const INGESTIBLE = /\.(md|txt|markdown|js|mjs|cjs|ts|py|sh|bash|zsh|java)$/

function collectMarkdown(source, since = null) {
  const files = []
  const stat  = fs.statSync(source)

  if (stat.isFile()) {
    if (INGESTIBLE.test(source)) files.push(source)
    return files
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const full = path.join(source, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMarkdown(full, since))
    } else if (INGESTIBLE.test(entry.name)) {
      if (since) {
        const mtime = fs.statSync(full).mtime
        if (mtime < new Date(since)) continue
      }
      files.push(full)
    }
  }
  return files
}

// ── NER pre-pass ─────────────────────────────────────────────────────────────

function compromisePrePass(text) {
  const doc = nlp(text)
  const people  = doc.people().out('array')
  const places  = doc.places().out('array')
  const orgs    = doc.organizations().out('array')
  const topics  = doc.topics().out('array')
  return [...new Set([...people, ...places, ...orgs, ...topics])].filter(Boolean)
}

function buildHintsSection(comprHints, nerEntities) {
  const lines = []
  if (comprHints.length)  lines.push(`Compromise pre-pass detected: ${comprHints.slice(0, 20).join(', ')}`)
  if (nerEntities.length) {
    const fmt = nerEntities.slice(0, 30).map(e => `${e.text} (${e.type})`).join(', ')
    lines.push(`GLiNER entities: ${fmt}`)
  }
  return lines.length ? `\nHINTS (from NER pre-pass — treat as signals, not facts):\n${lines.join('\n')}\n` : ''
}

// ── Extract entities from text (core, language-aware) ────────────────────────

async function extractFromText(content, { source = '', language = null, useNer = true } = {}) {
  if (content.trim().length < 20) return []

  const lang   = language || detectLanguage(source, content)
  const isCode = CODE_LANGUAGES.has(lang)

  // NER pre-passes are useful for prose, mostly noise for code
  const comprHints  = isCode ? [] : compromisePrePass(content)
  const nerEntities = isCode || !useNer ? [] : await extractEntities(content)
  const hints       = buildHintsSection(comprHints, nerEntities)

  const system = isCode ? CODE_CRAWLER_SYSTEM : CRAWLER_SYSTEM
  const prompt = isCode
    ? CODE_EXTRACTION_PROMPT(content, lang)
    : EXTRACTION_PROMPT(content) + hints

  const raw = await ask({ prompt, system, task: 'extraction', json: true })

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    try {
      const parsed = JSON.parse(stripped)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      console.error(`  ✗ Could not parse extraction output for ${source || 'input'}`)
      return []
    }
  }
}

async function extractFromFile(filePath, { useNer = true } = {}) {
  const content = fs.readFileSync(filePath, 'utf8')
  return extractFromText(content, { source: filePath, useNer })
}

// ── crawlText — core pipeline, works on raw text (used by API + CLI) ─────────

async function crawlText({ text, source = 'api', language = null, dryRun = false, verbose = false, noNer = false }) {
  const useNer   = !noNer && await nerAvailable()
  const graph    = await loadGraph()
  const entities = await extractFromText(text, { source, language, useNer })

  let entitiesCreated = 0
  let skipped         = 0
  const created       = []

  for (const entity of entities) {
    if (!entity['@type'] || !entity.name) {
      if (verbose) console.log(`  ✗ Skipped (missing type/name): ${JSON.stringify(entity).slice(0, 60)}`)
      skipped++
      continue
    }

    const dupes = findDuplicates(entity, graph)
    if (dupes.length && dupes[0].score >= 95) {
      if (verbose) console.log(`  ~ Duplicate: ${entity.name} → ${dupes[0].id}`)
      skipped++
      continue
    }

    entity.metadata = { source: `crawl:${source}` }

    if (!dryRun) {
      try {
        const result = writeEntity(entity, graph)
        if (result.created) {
          entitiesCreated++
          created.push(entity)
          if (verbose) console.log(`  ✓ Created: ${result.id}`)
        } else {
          skipped++
        }
      } catch (e) {
        console.error(`  ✗ Failed to write ${entity.name}: ${e.message}`)
        skipped++
      }
    } else {
      entitiesCreated++
      created.push(entity)
    }
  }

  if (!dryRun && entitiesCreated > 0) scribe()

  return { entitiesFound: entities.length, entitiesCreated, skipped, entities: created, dryRun }
}

// ── Main crawl (file-based, delegates to crawlText per file) ─────────────────

async function crawl({ source, since, dryRun = false, verbose = false, noNer = false }) {
  const files = collectMarkdown(source, since)
  if (!files.length) {
    console.log('  No markdown/code files found.')
    return { filesProcessed: 0, entitiesFound: 0, entitiesCreated: 0, skipped: 0 }
  }

  const useNer = !noNer && await nerAvailable()
  if (verbose && !noNer) console.log(`  NER service: ${useNer ? 'online (aid:3773)' : 'offline — using Ollama only'}`)

  console.log(`\n  THE CRAWLER descends. (${files.length} file${files.length === 1 ? '' : 's'})\n`)

  let entitiesFound   = 0
  let entitiesCreated = 0
  let skipped         = 0

  for (const file of files) {
    const name = path.basename(file)
    process.stdout.write(`  → ${name} ... `)

    const text   = fs.readFileSync(file, 'utf8')
    const result = await crawlText({ text, source: name, dryRun, verbose, noNer: !useNer })

    entitiesFound   += result.entitiesFound
    entitiesCreated += result.entitiesCreated
    skipped         += result.skipped

    if (!result.entitiesFound) {
      console.log('nothing found')
    } else {
      console.log(`${result.entitiesFound} found, ${result.entitiesCreated} created, ${result.skipped} skipped`)
      if (dryRun && verbose) {
        for (const e of result.entities) console.log(`     [dry-run] ${e['@id'] || e.name} (${e['@type']})`)
      }
    }
  }

  return { filesProcessed: files.length, entitiesFound, entitiesCreated, skipped }
}

// ── Sync queue to remote server ───────────────────────────────────────────────

async function syncQueue({ verbose = false, dryRun = false } = {}) {
  if (!isRemote) {
    console.error('Sync requires GRIMOIRE_HOST to be set (e.g. http://aid:3663).')
    process.exit(1)
  }

  const pending = loadQueue().filter(e => e.status === 'pending')
  if (!pending.length) {
    console.log('  Queue is empty — nothing to sync.')
    return { synced: 0, failed: 0, remaining: 0 }
  }

  console.log(`\n  Syncing ${pending.length} queued item${pending.length === 1 ? '' : 's'} → ${config.host}\n`)

  let synced  = 0
  let failed  = 0

  for (const entry of pending) {
    process.stdout.write(`  → ${entry.source} (${entry.id}) ... `)

    if (dryRun) {
      console.log('[dry-run] would POST')
      synced++
      continue
    }

    try {
      const { data } = await axios.post(
        `${config.host}/api/crawl`,
        { text: entry.text, source: entry.source, language: entry.language, noNer: entry.noNer },
        { headers: { 'Content-Type': 'application/json' }, timeout: 300_000 }
      )
      updateEntry(entry.id, 'synced')
      synced++
      console.log(`${data.entitiesCreated} created, ${data.skipped} skipped`)
      if (verbose && data.entities?.length) {
        for (const e of data.entities) console.log(`     ✓ ${e['@id'] || e.name} (${e['@type']})`)
      }
    } catch (e) {
      const msg = e.response?.data?.error || e.message
      updateEntry(entry.id, 'failed', msg)
      failed++
      console.log(`FAILED: ${msg}`)
    }
  }

  if (!dryRun) clearSynced()

  const remaining = loadQueue().filter(e => e.status === 'pending').length
  console.log(`\n  Sync complete.  Synced: ${synced}  Failed: ${failed}  Remaining: ${remaining}\n`)
  return { synced, failed, remaining }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['dry-run', 'json', 'verbose', 'no-ner', 'queue', 'sync', 'list-queue', 'clear-queue'],
    alias:   { j: 'json', v: 'verbose', n: 'dry-run', q: 'queue', s: 'sync' },
    string:  ['source', 'since', 'language'],
  })

  // ── grim crawl --sync ─────────────────────────────────────────────────────
  if (args.sync) {
    const stats = await syncQueue({ verbose: args.verbose, dryRun: args['dry-run'] })
    if (args.json) console.log(JSON.stringify(stats, null, 2))
    return
  }

  // ── grim crawl --list-queue ───────────────────────────────────────────────
  if (args['list-queue']) {
    const entries = loadQueue()
    const pending = entries.filter(e => e.status === 'pending')
    console.log(`\n  Queue: ${QUEUE_FILE}`)
    console.log(`  Total: ${entries.length}  Pending: ${pending.length}\n`)
    for (const e of entries) {
      const preview = e.text.slice(0, 60).replace(/\s+/g, ' ')
      console.log(`  [${e.status.padEnd(7)}] ${e.id}  ${e.source}  "${preview}..."`)
    }
    console.log()
    return
  }

  // ── grim crawl --clear-queue ──────────────────────────────────────────────
  if (args['clear-queue']) {
    const remaining = clearSynced()
    console.log(`  Queue cleared. ${remaining} pending item${remaining === 1 ? '' : 's'} kept.`)
    return
  }

  // ── grim crawl --source <path> [--queue] ─────────────────────────────────
  const source = args.source || args._[0]
  if (!source) {
    console.error('Usage:')
    console.error('  grim crawl --source <path>           # extract + write (local mode)')
    console.error('  grim crawl --source <path> --queue   # queue for later sync')
    console.error('  grim crawl --sync                    # drain queue to server')
    console.error('  grim crawl --list-queue              # show queued items')
    console.error('  grim crawl --clear-queue             # remove synced/failed entries')
    process.exit(1)
  }

  if (!fs.existsSync(source)) {
    console.error(`Source not found: ${source}`)
    process.exit(1)
  }

  // ── Queue mode: store text locally, no extraction yet ────────────────────
  if (args.queue) {
    const files = collectMarkdown(source, args.since)
    if (!files.length) { console.log('  No ingestible files found.'); return }
    console.log(`\n  Queueing ${files.length} file${files.length === 1 ? '' : 's'} → ${QUEUE_FILE}\n`)
    for (const file of files) {
      const text   = fs.readFileSync(file, 'utf8')
      const entry  = enqueue({ text, source: path.basename(file), language: args.language || null, noNer: args['no-ner'] })
      console.log(`  + ${path.basename(file)} (${entry.id})`)
    }
    console.log(`\n  Queued. Run: grim crawl --sync  when ${config.host || 'the server'} is reachable.\n`)
    return
  }

  // ── Local mode: extract + write directly ─────────────────────────────────
  if (!isLocal) {
    console.error('Direct crawl requires GRIMOIRE_ROOT (local KB access).')
    console.error('To queue for later sync: grim crawl --source <path> --queue')
    process.exit(1)
  }

  const stats = await crawl({
    source,
    since:   args.since,
    dryRun:  args['dry-run'],
    verbose: args.verbose,
    noNer:   args['no-ner'],
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

module.exports = { crawl, crawlText, syncQueue }

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1) })
