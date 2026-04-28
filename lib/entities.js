'use strict'

/**
 * lib/entities.js — Entity creation utilities
 *
 * Shared helpers for: type→dir mapping, ID/slug generation,
 * writing new entity files, deduplication.
 *
 * Used by: grim-crawl, grim-tome, grim-pathfind, grim-session
 */

const fs   = require('node:fs')
const path = require('node:path')
const { config } = require('./env')

// ── Type mappings ─────────────────────────────────────────────────────────────

const TYPE_TO_DIR = {
  'Person':              'people',
  'Project':             'projects',
  'DefinedTerm':         'concepts',
  'Event':               'events',
  'SoftwareApplication': 'systems',
  'SoftwareSourceCode':  'repositories',
  'AgentModel':          'meta',
  'UserModel':           'meta',
  'HowTo':               'meta',
  'Session':             'meta',
  'Dream':               'meta',
}

const TYPE_TO_ID_PREFIX = {
  'Person':              'person',
  'Project':             'project',
  'DefinedTerm':         'concept',
  'Event':               'event',
  'SoftwareApplication': 'system',
  'SoftwareSourceCode':  'repo',
  'AgentModel':          'meta',
  'UserModel':           'meta_user',
  'HowTo':               'meta_technique',
  'Session':             'meta_session',
  'Dream':               'meta_dream',
}

// ── Slug / ID helpers ─────────────────────────────────────────────────────────

function toSlug(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/**
 * Generate a canonical entity ID from type and name.
 * e.g. ('Person', 'Jane Smith') → 'person_jane_smith'
 */
function toId(type, name) {
  const prefix = TYPE_TO_ID_PREFIX[type] || toSlug(type)
  return `${prefix}_${toSlug(name)}`
}

/**
 * Generate a filename from an entity ID.
 * e.g. 'person_jane_smith' → 'person-jane-smith.json'
 */
function toFilename(id) {
  return id.replace(/_/g, '-') + '.json'
}

// ── Entity directory path ─────────────────────────────────────────────────────

/**
 * Get the full directory path for a given entity type.
 */
function entityDir(type) {
  const dir = TYPE_TO_DIR[type]
  if (!dir) throw new Error(`Unknown entity type: ${type}`)
  if (!config.root) throw new Error('GRIMOIRE_ROOT not set — cannot write entities locally')
  return path.join(config.root, 'entities', dir)
}

// ── Write new entity ──────────────────────────────────────────────────────────

/**
 * Write a new entity to disk.
 * Validates required fields, generates @id and file path if missing.
 * NEVER appends text to JSON files — always parse/modify/stringify.
 *
 * @param {object} entity - entity object with at minimum @type and name
 * @param {object} [graph] - loaded graph for duplicate detection
 * @returns {{ id: string, file: string, created: boolean }}
 */
function writeEntity(entity, graph = null) {
  const type = entity['@type']
  if (!type)       throw new Error('Entity missing @type')
  if (!entity.name) throw new Error('Entity missing name')

  const id       = entity['@id'] || toId(type, entity.name)
  const filename = toFilename(id)
  const dir      = entityDir(type)
  const file     = path.join(dir, filename)

  // Duplicate check
  if (graph && graph.entities[id]) {
    return { id, file, created: false }
  }
  if (fs.existsSync(file)) {
    return { id, file, created: false }
  }

  fs.mkdirSync(dir, { recursive: true })

  const now = new Date().toISOString().slice(0, 10)
  const full = {
    '@context': 'https://schema.org',
    '@type':    type,
    '@id':      id,
    'name':     entity.name,
    ...entity,
    '@id': id,  // ensure correct id even if entity had a different one
    'metadata': {
      dateCreated:  now,
      dateModified: now,
      source: entity.metadata?.source || 'manual',
      ...(entity.metadata || {}),
    },
    'notes':         entity.notes         || [],
    'backlinks':     entity.backlinks     || [],
    'relationships': entity.relationships || {},
    'tags':          entity.tags          || [
      `type/${toSlug(type)}`,
    ],
  }

  // Preserve temporal fields at top level — strip them if not provided
  // so entities without bounds stay clean (no null fields cluttering the JSON)
  if (!entity.validFrom)     delete full.validFrom
  if (!entity.validUntil)    delete full.validUntil
  if (!entity.assertionType) delete full.assertionType

  fs.writeFileSync(file, JSON.stringify(full, null, 2))
  return { id, file, created: true }
}

/**
 * Find potential duplicates of an entity in the graph by name similarity.
 * Returns array of { id, name, score } sorted by score desc.
 */
function findDuplicates(entity, graph) {
  const q = (entity.name || '').toLowerCase().trim()
  const generatedId = toId(entity['@type'] || '', entity.name || '')
  const results = []

  for (const [id, existing] of Object.entries(graph.entities || {})) {
    if (id === generatedId) {
      results.push({ id, name: existing.name, score: 100 })
      continue
    }
    const name = (existing.name || '').toLowerCase()
    if (name === q)             results.push({ id, name: existing.name, score: 95 })
    else if (name.includes(q) || q.includes(name)) results.push({ id, name: existing.name, score: 60 })
  }

  return results.sort((a, b) => b.score - a.score)
}

module.exports = {
  TYPE_TO_DIR,
  TYPE_TO_ID_PREFIX,
  toSlug,
  toId,
  toFilename,
  entityDir,
  writeEntity,
  findDuplicates,
}
