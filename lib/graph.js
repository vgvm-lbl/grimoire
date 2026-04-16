'use strict'

/**
 * lib/graph.js — Grimoire graph loader
 *
 * Loads graph.json in local or remote mode.
 * All read-side tools (oracle, tome, divine) use this instead of
 * reading graph.json themselves.
 *
 * Usage:
 *   const { loadGraph } = require('./graph')
 *   const graph = await loadGraph()
 */

const fs    = require('node:fs')
const path  = require('node:path')
const axios = require('axios')
const { config, isLocal, isRemote, requireMode } = require('./env')

/**
 * Load the graph index.
 * - Local mode: reads indexes/graph.json from GRIMOIRE_ROOT
 * - Remote mode: GET http://GRIMOIRE_HOST/api/graph
 *
 * @returns {Promise<object>} graph — { entities, edges, backlinks, tags, index, _meta }
 */
async function loadGraph() {
  if (isLocal) {
    const graphFile = path.join(config.root, 'indexes', 'graph.json')
    if (!fs.existsSync(graphFile)) {
      console.error(`Graph index not found: ${graphFile}`)
      console.error(`Run 'grim scribe' on aid to build it.`)
      process.exit(1)
    }
    return JSON.parse(fs.readFileSync(graphFile, 'utf8'))
  }

  if (isRemote) {
    try {
      const res = await axios.get(`${config.host}/api/graph`, { timeout: 8000 })
      return res.data
    } catch (e) {
      const msg = e.response ? `HTTP ${e.response.status}` : e.message
      console.error(`Could not reach Grimoire server at ${config.host}: ${msg}`)
      console.error(`Make sure 'grim serve' is running on aid.`)
      process.exit(1)
    }
  }

  requireMode('any') // will exit with helpful message
}

/**
 * Load a single entity by ID directly from its JSON file (local only).
 * Useful for write operations that need the full entity, not just the index summary.
 *
 * @param {string} id - entity @id
 * @param {object} graph - loaded graph (for file path lookup)
 * @returns {object} full entity JSON
 */
function loadEntity(id, graph) {
  if (!isLocal) {
    throw new Error('loadEntity() requires local KB access (GRIMOIRE_ROOT)')
  }
  const entry = graph.entities[id]
  if (!entry) throw new Error(`Entity not found in graph: ${id}`)
  const file = path.join(config.root, entry.file)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Write a full entity back to its file (local only).
 * Always uses JSON.parse/stringify — never appends markdown to JSON files.
 *
 * @param {string} id
 * @param {object} entity - full entity object
 * @param {object} graph - loaded graph (for file path lookup)
 */
function saveEntity(id, entity, graph) {
  if (!isLocal) {
    throw new Error('saveEntity() requires local KB access (GRIMOIRE_ROOT)')
  }
  const entry = graph.entities[id]
  if (!entry) throw new Error(`Entity not found in graph: ${id}`)
  const file = path.join(config.root, entry.file)
  entity.metadata = entity.metadata || {}
  entity.metadata.dateModified = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(file, JSON.stringify(entity, null, 2))
}

module.exports = { loadGraph, loadEntity, saveEntity }
