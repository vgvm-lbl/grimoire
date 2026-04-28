#!/usr/bin/env node
'use strict'

/**
 * grim-ingest.js — Conversation & transcript ingestion
 *
 * Reads a chat log, meeting notes, session transcript, or any messy text
 * and asks Ollama (THE ARCHIVIST) to judge what's KB-worthy. Unlike grim crawl,
 * which extracts all entities via NER from structured files, ingest is a
 * judgment layer: Ollama decides what has durable value and what is noise.
 *
 * Difference from grim crawl:
 *   crawl    file-based, NER pipeline + Ollama, extracts all entities present
 *   ingest   conversation-based, Ollama judges KB-worthiness, selective
 *
 * CLI:
 *   grim ingest session.txt
 *   cat chat.md | grim ingest
 *   grim ingest meeting.txt --context "homelab ollama"
 *   grim ingest transcript.md --yes
 *   grim ingest notes.txt --dry-run
 *   grim ingest session.txt --format chat --json
 *
 * Options:
 *   --context <query>   Oracle search to inject existing KB context (dedup hint)
 *   --format <type>     Input hint: chat|meeting|diary|notes|thread (default: auto)
 *   --yes               Write without confirmation prompt
 *   --dry-run           Show extraction only, never write
 *   --json              Output result as JSON to stdout
 *   --source <label>    Label for entity metadata (default: filename or 'stdin')
 *   --timeout <ms>      Ollama timeout (default: 120000)
 */

const fs       = require('node:fs')
const path     = require('node:path')
const readline = require('node:readline')
const minimist = require('minimist')
const { askJSON }           = require('./model-ask')
const { loadGraph }         = require('../lib/graph')
const { writeEntity, findDuplicates } = require('../lib/entities')
const { scribe }            = require('./grim-scribe')
const { search }            = require('./grim-oracle')
const { isLocal, requireMode } = require('../lib/env')

// ── THE ARCHIVIST ─────────────────────────────────────────────────────────────
//
// Ruthless selectivity is the whole point. Crawl extracts everything; ingest
// extracts only what a person would want to find six months later.

const ARCHIVIST_SYSTEM = `You are THE ARCHIVIST. You read conversations, meeting notes, and session transcripts and decide what is worth keeping in a knowledge graph permanently.

You are ruthlessly selective. Most conversation is noise. Extract ONLY signal — things worth finding in 6 months:
  - Named concepts or patterns that were defined or clarified (not just mentioned in passing)
  - Decisions that were reached and the reasoning behind them
  - Projects, tools, or systems described with enough detail to be useful standalone
  - Non-obvious relationships between entities — latent connections, dependencies
  - Bugs, constraints, or quirks that would surprise future-you

Do NOT extract:
  - Ephemeral status ("it's working now", "done", "looks good")
  - Open questions without answers
  - Generic observations without specifics
  - Information already present in the provided KB context
  - Process steps that are obvious from context

Output is always valid JSON — nothing else, no markdown, no commentary.
Return a JSON array of entity objects, or [] if nothing is KB-worthy.`

// ── Format hints ──────────────────────────────────────────────────────────────
//
// Shapes the extraction prompt emphasis for different input types.
// 'auto' means no hint — let the model figure it out from the text.

const FORMAT_HINTS = {
  chat:    `This is a chat transcript between a user and an AI assistant. Focus on: decisions made, concepts named or defined, systems designed, bugs found and fixed.`,
  meeting: `This is meeting notes. Focus on: decisions reached, architectural choices, named projects or initiatives, cross-team dependencies.`,
  diary:   `This is a diary or journal entry. Focus on: named projects or concepts, key insights, decisions about future direction, lessons learned.`,
  notes:   `These are freeform notes. Extract entities that are clearly defined or described in enough detail to be useful standalone.`,
  thread:  `This is a message thread or async discussion. Focus on: consensus reached, technical decisions, named concepts or systems that emerged from the discussion.`,
  auto:    '',
}

// ── Build extraction prompt ───────────────────────────────────────────────────

function buildPrompt(text, existingContext, format = 'auto') {
  const hint      = FORMAT_HINTS[format] || FORMAT_HINTS.auto
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[... truncated ...]' : text

  const parts = []
  if (hint)            parts.push(`INPUT TYPE: ${hint}`)
  if (existingContext) parts.push(`EXISTING KB ENTITIES (do NOT re-extract these):\n${existingContext}`)

  parts.push(`Return a JSON object with a single key "entities" containing an array.
Each entity in the array must have:
- "@type": "Person" | "Project" | "DefinedTerm" | "SoftwareApplication" | "Event"
- "@id": "{type_prefix}_{slug}" (lowercase, underscores, e.g. definedterm_task_routing)
- "name": concise display name
- "description": 1-2 sentences — what this IS, written for a reader with no prior context
- "tags": string array (domain/X, tech/X, concept/X, status/X)
- "relationships": typed edges to other entities in THIS extraction only

Return {"entities": []} if nothing meets the bar. No other keys. No markdown.

TRANSCRIPT:
${truncated}`)

  return parts.join('\n\n')
}

// ── Oracle context injection ──────────────────────────────────────────────────

async function getContext(query) {
  try {
    const graph   = await loadGraph()
    const results = search(graph, { query, limit: 8 })
    return results.map(({ entity: e }) =>
      `[${e['@id']}] ${e['@type']} — ${e.name}: ${(e.description || '').slice(0, 100)}`
    ).join('\n')
  } catch {
    return ''
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

function formatEntity(e, index) {
  const lines = [`  [${index}] ${e['@type']}: ${e.name}`]
  if (e.description) lines.push(`      ${e.description.slice(0, 130)}`)
  if (e.tags?.length) lines.push(`      Tags: ${e.tags.join(', ')}`)
  return lines.join('\n')
}

// ── Unwrap model output ───────────────────────────────────────────────────────
//
// Ollama's json mode returns a valid JSON value, but not always a bare array.
// The prompt asks for {"entities": [...]}, but the model may return a bare array,
// an object with a different key, or wrap the array in a nested structure.

function unwrapEntities(val) {
  if (Array.isArray(val)) return val
  if (val && typeof val === 'object') {
    if (Array.isArray(val.entities)) return val.entities
    // Check any array-valued top-level key
    for (const v of Object.values(val)) {
      if (Array.isArray(v)) return v
    }
  }
  return []
}

// ── Confirmation ──────────────────────────────────────────────────────────────

function confirm(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.toLowerCase().startsWith('y'))
    })
  })
}

// ── Write to KB ───────────────────────────────────────────────────────────────

async function writeEntities(entities, source) {
  const graph   = await loadGraph()
  let created   = 0
  let skipped   = 0
  const written = []

  for (const entity of entities) {
    if (!entity['@type'] || !entity.name) { skipped++; continue }

    // Score >= 90 is a confident duplicate; lower scores may be related-but-distinct
    const dupes = findDuplicates(entity, graph)
    if (dupes.length && dupes[0].score >= 90) {
      console.error(`  ~ Duplicate: ${entity.name} → ${dupes[0].id}`)
      skipped++
      continue
    }

    entity.metadata = { source: `ingest:${source}` }

    try {
      const result = writeEntity(entity, graph)
      if (result.created) {
        console.error(`  ✓ ${result.id}`)
        written.push(result.id)
        created++
      } else {
        skipped++
      }
    } catch (e) {
      console.error(`  ✗ Failed to write ${entity.name}: ${e.message}`)
      skipped++
    }
  }

  if (created > 0) scribe()
  return { created, skipped, written }
}

// ── Core ingest pipeline (exported for programmatic use) ─────────────────────

/**
 * Run the archivist pass on text and return extracted entities.
 * Does not write to KB — caller decides what to do with the result.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.source]
 * @param {string} [opts.contextQuery]  Oracle search query for KB dedup context
 * @param {string} [opts.format]        'auto'|'chat'|'meeting'|'diary'|'notes'|'thread'
 * @param {number} [opts.timeout]
 * @returns {{ entities: object[], contextUsed: boolean, source: string }}
 */
async function ingest(text, opts = {}) {
  const { source = 'stdin', contextQuery, format = 'auto', timeout = 120000 } = opts

  const existingContext = contextQuery ? await getContext(contextQuery) : ''
  const prompt = buildPrompt(text, existingContext, format)

  let raw
  try {
    raw = await askJSON({ prompt, system: ARCHIVIST_SYSTEM, task: 'extraction', timeout })
  } catch (e) {
    throw new Error(`Archivist extraction failed: ${e.message}`)
  }

  // Model returns {"entities": [...]} but may also return a bare array or other wrapping
  const entities = unwrapEntities(raw)
  return { entities, contextUsed: !!existingContext, source }
}

module.exports = { ingest, unwrapEntities, buildPrompt }

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['dry-run', 'json', 'yes'],
    alias:   { y: 'yes', j: 'json', n: 'dry-run' },
    string:  ['context', 'format', 'source'],
    default: { format: 'auto', timeout: 120000 },
  })

  requireMode('any')

  let text    = ''
  const fileArg = args._[0]

  if (fileArg) {
    if (!fs.existsSync(fileArg)) {
      console.error(`File not found: ${fileArg}`)
      process.exit(1)
    }
    text = fs.readFileSync(fileArg, 'utf8')
  } else if (!process.stdin.isTTY) {
    text = fs.readFileSync('/dev/stdin', 'utf8')
  }

  if (!text.trim()) {
    console.error('Usage: grim ingest <file>')
    console.error('       cat transcript.txt | grim ingest')
    console.error('       grim ingest session.md --context "homelab ai" --yes')
    process.exit(1)
  }

  const source = args.source || (fileArg ? path.basename(fileArg) : 'stdin')

  if (!args.json) {
    process.stderr.write(`\n  THE ARCHIVIST reads (${text.length} chars${args.context ? ' + KB context' : ''})`)
    const spinner = setInterval(() => process.stderr.write('.'), 3000)

    let result
    try {
      result = await ingest(text, {
        source,
        contextQuery: args.context,
        format:       args.format,
        timeout:      Number(args.timeout) || 120000,
      })
    } catch (e) {
      clearInterval(spinner)
      process.stderr.write('\n')
      console.error(`grim ingest failed: ${e.message}`)
      process.exit(1)
    }

    clearInterval(spinner)
    process.stderr.write('\n')

    const { entities } = result

    if (!entities.length) {
      console.log(`\n  Nothing KB-worthy found.\n`)
      return
    }

    console.log(`\n  ARCHIVIST EXTRACTS ${entities.length} ENTIT${entities.length === 1 ? 'Y' : 'IES'}\n`)
    entities.forEach((e, i) => console.log(formatEntity(e, i + 1)))
    console.log()

    if (args['dry-run']) return

    if (!isLocal) {
      console.error('  Write requires GRIMOIRE_ROOT (local KB access).')
      return
    }

    let write = args.yes
    if (!write) {
      if (process.stdin.isTTY) {
        write = await confirm(`  Write ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} to KB? [y/N] `)
      } else {
        // stdin was consumed for input — can't prompt. Require --yes for non-TTY writes.
        console.log(`  Pipe mode: use --yes to write, --dry-run to preview only.\n`)
        return
      }
    }

    if (!write) {
      console.log(`  Skipped — nothing written.\n`)
      return
    }

    const stats = await writeEntities(entities, source)
    console.log(`\n  Ingested: ${stats.created} created, ${stats.skipped} skipped.\n`)

  } else {
    // JSON mode: output clean JSON, no spinners
    let result
    try {
      result = await ingest(text, {
        source,
        contextQuery: args.context,
        format:       args.format,
        timeout:      Number(args.timeout) || 120000,
      })
    } catch (e) {
      console.log(JSON.stringify({ error: e.message }))
      process.exit(1)
    }
    console.log(JSON.stringify(result, null, 2))
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
