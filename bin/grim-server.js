#!/usr/bin/env node
'use strict'

/**
 * grim-server.js — The Grimoire Server
 *
 * Exposes the KB to the LAN via HTTP REST API + MCP endpoint.
 * Binds to 0.0.0.0 so clients on other hosts can reach it via http://aid:3663
 *
 * Routes:
 *   GET  /health                 → status + graph stats
 *   GET  /api/graph              → full graph.json (for lib/graph.js remote mode)
 *   GET  /api/oracle             → search (?q=&tag=&type=&depth=&limit=)
 *   GET  /api/divine             → health report
 *   GET  /api/session/briefing   → load briefing
 *   POST /api/session/save       → save session
 *   POST /api/tome/recall        → recall entity
 *   POST /api/tome/remember      → create entity
 *   POST /api/tome/relate        → add relationship
 *   POST /api/tome/annotate      → annotate entity
 *   POST /api/scribe             → rebuild graph index + bust cache
 *   POST /noise-floor/think      → add thought to stream
 *   GET  /noise-floor/context    → get recent thoughts
 *   POST /mcp                    → MCP Streamable HTTP transport
 *
 * Run on aid: node bin/grim-server.js
 */

const fs      = require('node:fs')
const path    = require('node:path')
const express = require('express')
const cors    = require('cors')

const { loadGraph }      = require('../lib/graph')
const { runChecks, computeScore } = require('./grim-divine')
const { search }         = require('./grim-oracle')
const { loadBriefing, saveSession } = require('./grim-session')
const { recall, remember, relate, annotate } = require('./grim-tome')
const { config, requireMode } = require('../lib/env')
const { semanticSearch, indexReady } = require('../lib/vectors')

requireMode('local')

const app  = express()
const PORT = config.port

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── Graph cache (reload every 30s or on-demand) ───────────────────────────────

let _graphCache     = null
let _graphCachedAt  = 0
const CACHE_TTL_MS  = 30_000

async function getGraph(force = false) {
  const now = Date.now()
  if (!force && _graphCache && (now - _graphCachedAt) < CACHE_TTL_MS) return _graphCache
  _graphCache    = await loadGraph()
  _graphCachedAt = now
  return _graphCache
}

// ── Noise Floor (thought stream) ──────────────────────────────────────────────

const NOISE_FILE = path.join(config.root, 'noise-floor.json')

function loadThoughts() {
  try { return JSON.parse(fs.readFileSync(NOISE_FILE, 'utf8')) } catch { return [] }
}

function saveThoughts(thoughts) {
  fs.writeFileSync(NOISE_FILE, JSON.stringify(thoughts.slice(-500), null, 2))
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const graph = await getGraph()
    const m     = graph._meta || {}
    res.json({ status: 'ok', entities: m.entityCount, edges: m.edgeCount, builtAt: m.builtAt })
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message })
  }
})

app.get('/api/graph', async (req, res) => {
  try {
    const graph = await getGraph(req.query.fresh === '1')
    res.json(graph)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/scribe', async (req, res) => {
  try {
    const { scribeAll } = require('./grim-scribe')
    const { graph, vectors } = await scribeAll({ force: req.body?.force ?? false })
    _graphCache    = null
    _graphCachedAt = 0
    await getGraph()
    res.json({ ok: true, entities: Object.keys(graph.entities).length, edges: graph._meta?.edgeCount ?? 0, vectors })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/oracle', async (req, res) => {
  try {
    const graph = await getGraph()
    const query = req.query.q || null
    const limit = Number(req.query.limit || 20)
    let semanticHits = []
    if (query && !req.query['no-semantic']) {
      try {
        if (await indexReady()) semanticHits = await semanticSearch(query, limit * 2)
      } catch { /* degraded */ }
    }
    const results = search(graph, {
      query,
      tag:   req.query.tag  || null,
      type:  req.query.type || null,
      depth: Number(req.query.depth || 0),
      limit,
      semanticHits,
    })
    res.json(results)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/divine', async (req, res) => {
  try {
    const graph   = await getGraph()
    const results = runChecks(graph)
    const scoring = computeScore(results)
    res.json({ ...results, ...scoring })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/session/briefing', async (req, res) => {
  try {
    const briefing = await loadBriefing()
    res.json(briefing)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/session/save', async (req, res) => {
  try {
    const result = await saveSession(req.body)
    _graphCache = null // invalidate cache
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tome/recall', async (req, res) => {
  try {
    const { query, depth = 1 } = req.body
    if (!query) return res.status(400).json({ error: 'query required' })
    const results = await recall(query, { depth })
    res.json(results)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tome/remember', async (req, res) => {
  try {
    const { type, ...rest } = req.body
    const body = type ? { '@type': type, ...rest } : req.body
    const result = await remember(body)
    _graphCache = null
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tome/relate', async (req, res) => {
  try {
    const { fromId, toId, relationType } = req.body
    if (!fromId || !toId || !relationType) return res.status(400).json({ error: 'fromId, toId, relationType required' })
    const result = await relate(fromId, toId, relationType)
    _graphCache = null
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tome/annotate', async (req, res) => {
  try {
    const { entityId, note } = req.body
    if (!entityId || !note) return res.status(400).json({ error: 'entityId and note required' })
    const result = await annotate(entityId, note)
    _graphCache = null
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Noise Floor ───────────────────────────────────────────────────────────────

app.post('/noise-floor/think', (req, res) => {
  const { text, source = 'unknown', type = 'observation' } = req.body
  if (!text) return res.status(400).json({ error: 'text required' })
  const thoughts = loadThoughts()
  const thought  = { at: new Date().toISOString(), text, source, type }
  thoughts.push(thought)
  saveThoughts(thoughts)
  res.json({ ok: true, count: thoughts.length })
})

app.get('/noise-floor/context', (req, res) => {
  const thoughts = loadThoughts()
  const limit    = Number(req.query.limit || 30)
  res.json({
    thoughts: thoughts.slice(-limit),
    total:    thoughts.length,
  })
})

// ── MCP (Streamable HTTP transport) ──────────────────────────────────────────

const MCP_VERSION = '2024-11-05'

const MCP_TOOLS = [
  {
    name: 'oracle_search',
    description: 'Search the Grimoire knowledge graph by name, content, tag, or entity type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string',  description: 'Free-text search query' },
        tag:   { type: 'string',  description: 'Filter by tag (e.g. domain/workflow)' },
        type:  { type: 'string',  description: 'Filter by entity type (Person, Project, DefinedTerm, Event, SoftwareApplication)' },
        depth: { type: 'number',  description: 'Relationship traversal depth, default 0' },
        limit: { type: 'number',  description: 'Max results, default 10' },
      },
    },
  },
  {
    name: 'tome_recall',
    description: 'Recall a specific entity by name or ID with its full details and relationships.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Entity name, ID, or description fragment' },
        depth: { type: 'number', description: 'How many relationship hops to expand, default 1' },
      },
    },
  },
  {
    name: 'tome_remember',
    description: 'Create a new entity in the Grimoire knowledge graph.',
    inputSchema: {
      type: 'object',
      required: ['type', 'name', 'description'],
      properties: {
        type:          { type: 'string', description: 'Person | Project | DefinedTerm | Event | SoftwareApplication | HowTo' },
        name:          { type: 'string' },
        description:   { type: 'string' },
        tags:          { type: 'array', items: { type: 'string' } },
        relationships: { type: 'object', description: 'Typed edges: { "works_on": ["project_id"] }' },
      },
    },
  },
  {
    name: 'tome_relate',
    description: 'Add a typed relationship edge between two existing entities.',
    inputSchema: {
      type: 'object',
      required: ['fromId', 'toId', 'relationType'],
      properties: {
        fromId:       { type: 'string' },
        toId:         { type: 'string' },
        relationType: { type: 'string', description: 'works_on | depends_on | related_to | collaborates_with | part_of | uses | manages | aspect_of' },
      },
    },
  },
  {
    name: 'session_load',
    description: 'Load the Grimoire session briefing: identity, interrupted sessions, recent dreams, cheat codes, active goals.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_save',
    description: 'Save and close the current session with a summary of what happened.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        topic:     { type: 'string' },
        summary:   { type: 'string' },
        learned:   { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'divine_health',
    description: 'Get the current health score, grade, and issue breakdown of the knowledge graph.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'noise_floor_think',
    description: 'Add a thought to the Grimoire stream of consciousness.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text:   { type: 'string' },
        type:   { type: 'string', description: 'observation | realization | question | focus | decision' },
        source: { type: 'string' },
      },
    },
  },
  {
    name: 'scribe',
    description: 'Rebuild the graph index from entity files on disk and bust the server cache. Use after direct file edits.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function executeMCPTool(name, args) {
  switch (name) {
    case 'oracle_search': {
      const graph   = await getGraph()
      const results = search(graph, {
        query: args.query || null,
        tag:   args.tag   || null,
        type:  args.type  || null,
        depth: Number(args.depth || 0),
        limit: Number(args.limit || 10),
      })
      return { results: results.map(r => ({ ...r.entity, _score: r.score, _hops: r.hops })) }
    }

    case 'tome_recall': {
      const results = await recall(args.query, { depth: Number(args.depth || 1) })
      return { results: results.map(r => ({ ...r.entity, _score: r.score, _hops: r.hops })) }
    }

    case 'tome_remember': {
      const { type, ...rest } = args
      const result = await remember({ '@type': type, ...rest })
      _graphCache  = null
      return result
    }

    case 'tome_relate': {
      const result = await relate(args.fromId, args.toId, args.relationType)
      _graphCache  = null
      return result
    }

    case 'session_load': {
      return await loadBriefing()
    }

    case 'session_save': {
      const result = await saveSession(args)
      _graphCache  = null
      return result
    }

    case 'divine_health': {
      const graph   = await getGraph()
      const results = runChecks(graph)
      const scoring = computeScore(results)
      return { ...results, ...scoring }
    }

    case 'noise_floor_think': {
      const thoughts = loadThoughts()
      thoughts.push({ at: new Date().toISOString(), text: args.text, source: args.source || 'mcp', type: args.type || 'observation' })
      saveThoughts(thoughts)
      return { ok: true }
    }

    case 'scribe': {
      const { scribe } = require('./grim-scribe')
      await scribe()
      _graphCache    = null
      _graphCachedAt = 0
      const graph    = await getGraph()
      return { ok: true, entities: Object.keys(graph.entities).length, edges: graph._meta?.edgeCount ?? 0 }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

app.post('/mcp', async (req, res) => {
  const rpc = req.body

  // Handle batch
  if (Array.isArray(rpc)) {
    const responses = await Promise.all(rpc.map(r => handleRPC(r)))
    const out = responses.filter(Boolean)
    return res.json(out.length === 1 ? out[0] : out)
  }

  const response = await handleRPC(rpc)
  if (response === null) return res.status(202).end()
  res.json(response)
})

async function handleRPC(rpc) {
  const { id, method, params } = rpc

  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: MCP_VERSION,
          capabilities:    { tools: {} },
          serverInfo:      { name: 'grimoire', version: '0.1.0' },
        }}

      case 'notifications/initialized':
        return null // notification, no response

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }

      case 'tools/call': {
        const { name, arguments: args = {} } = params || {}
        const result = await executeMCPTool(name, args)
        return { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }}
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', async () => {
  try {
    const graph = await getGraph()
    const m     = graph._meta || {}
    console.log(`\n  ░ Grimoire online.`)
    console.log(`    http://0.0.0.0:${PORT}  (LAN: http://aid:${PORT})`)
    console.log(`    MCP endpoint: http://aid:${PORT}/mcp`)
    console.log(`    Entities: ${m.entityCount || '?'}  Edges: ${m.edgeCount || '?'}`)
    console.log(`    Noise Floor: ${path.relative(process.cwd(), NOISE_FILE)}\n`)
  } catch (e) {
    console.log(`\n  ░ Grimoire online (graph not yet indexed — run grim scribe).`)
    console.log(`    http://0.0.0.0:${PORT}\n`)
  }
})

module.exports = { app }
