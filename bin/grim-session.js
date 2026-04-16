#!/usr/bin/env node
'use strict'

/**
 * grim-session.js — SAVESTATE
 *
 * Session lifecycle management. Knows exactly where you were.
 * Wraps the grim load (wake) and grim save (sleep) commands.
 *
 * CLI:
 *   grim load                                 Load briefing — who am I, where was I
 *   grim load --json                          Machine-readable briefing
 *   grim save --topic "..." --summary "..."   End session, write save state
 *   grim save --summary "..." --learned "..." --next "..."
 *
 * Internal subcommands (used by server + other scripts):
 *   grim-session start --topic "..."          Create session entity
 *   grim-session heartbeat --summary "..."    Crash-recovery state flush
 *   grim-session note "text"                  Append note to active session
 *   grim-session goal "text"                  Upsert a persistent goal
 */

const fs        = require('node:fs')
const path      = require('node:path')
const minimist  = require('minimist')
const axios     = require('axios')
const { loadGraph, loadEntity, saveEntity } = require('../lib/graph')
const { writeEntity }                       = require('../lib/entities')
const { config, isLocal, isRemote, requireMode } = require('../lib/env')

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadEntityById(id, graph) {
  try { return loadEntity(id, graph) } catch { return null }
}

function allEntitiesOfType(type, graph) {
  return Object.values(graph.entities)
    .filter(e => e['@type'] === type)
    .map(e => {
      try { return loadEntity(e['@id'], graph) } catch { return e }
    })
}

function mostRecent(entities, n = 3) {
  return entities
    .sort((a, b) => (b.metadata?.dateModified || '') > (a.metadata?.dateModified || '') ? 1 : -1)
    .slice(0, n)
}

// ── Briefing (grim load) ──────────────────────────────────────────────────────

async function loadBriefing() {
  if (isRemote) {
    const res = await axios.get(`${config.host}/api/session/briefing`)
    return res.data
  }

  requireMode('local')
  const graph = await loadGraph()

  const agentModel = loadEntityById('meta_agent_grimoire', graph)
  const userModel  = loadEntityById('meta_user_model',     graph)

  // Find interrupted sessions (started but not ended)
  const sessions     = allEntitiesOfType('Session', graph)
  const interrupted  = sessions.filter(s => s.startedAt && !s.endedAt)
    .sort((a, b) => b.startedAt > a.startedAt ? 1 : -1)
  const recentSessions = sessions
    .filter(s => s.endedAt)
    .sort((a, b) => b.endedAt > a.endedAt ? 1 : -1)
    .slice(0, 3)

  // Dreams (last 3)
  const dreams = allEntitiesOfType('Dream', graph)
  const recentDreams = mostRecent(dreams, 3)

  // Techniques / cheat codes
  const techniques = allEntitiesOfType('HowTo', graph)

  // Personas
  const personas = Object.values(graph.entities)
    .filter(e => e['@type'] === 'AgentModel' && e.tags?.includes('meta/persona'))
    .map(e => ({ name: e.name, domain: e['@id'] }))

  // Active goals (entities tagged meta/goal)
  const goalIds    = graph.tags['meta/goal'] || []
  const activeGoals = goalIds.map(id => graph.entities[id]).filter(Boolean)

  return {
    agentModel,
    userModel,
    interruptedSession: interrupted[0] || null,
    recentSessions,
    recentDreams,
    activeGoals,
    techniques: techniques.map(t => ({ name: t.name, solution: t.solution })),
    personas,
  }
}

// ── Start session ─────────────────────────────────────────────────────────────

async function startSession(topic) {
  requireMode('local')
  const graph = await loadGraph()
  const now   = new Date().toISOString()
  const dateStr = now.slice(0, 10).replace(/-/g, '_')

  // Count today's sessions for unique ID
  const todayPrefix = `meta_session_${dateStr}`
  const todayCount  = Object.keys(graph.entities)
    .filter(id => id.startsWith(todayPrefix)).length + 1

  const id     = `${todayPrefix}_${String(todayCount).padStart(3, '0')}`
  const entity = {
    '@type':      'Session',
    '@id':        id,
    name:         `${topic} — ${now.slice(0, 10)}`,
    topic,
    startedAt:    now,
    summary:      '',
    decisions:    [],
    learned:      [],
    nextSteps:    [],
    entitiesCreated:  [],
    entitiesModified: [],
    tags: ['meta/session'],
    relationships: {},
    metadata: { dateCreated: now.slice(0, 10), source: 'session' },
  }

  writeEntity(entity, graph)
  return { id, startedAt: now }
}

// ── End session (grim save) ───────────────────────────────────────────────────

async function saveSession({ topic, summary, learned = [], nextSteps = [], decisions = [] }) {
  if (isRemote) {
    const res = await axios.post(`${config.host}/api/session/save`, { topic, summary, learned, nextSteps, decisions })
    return res.data
  }

  requireMode('local')
  const graph = await loadGraph()
  const now   = new Date().toISOString()

  // Find open session
  const sessions   = allEntitiesOfType('Session', graph)
  const open = sessions
    .filter(s => s.startedAt && !s.endedAt)
    .sort((a, b) => b.startedAt > a.startedAt ? 1 : -1)[0]

  if (open) {
    open.endedAt   = now
    open.summary   = summary
    open.decisions = decisions
    open.learned   = learned
    open.nextSteps = nextSteps
    if (topic) open.topic = topic
    saveEntity(open['@id'], open, graph)
    return { ok: true, id: open['@id'], endedAt: now }
  }

  // No open session — create a completed one
  const result = await startSession(topic || 'Session')
  const newGraph = await loadGraph()
  const newSessions = allEntitiesOfType('Session', newGraph)
  const fresh = newSessions.find(s => s['@id'] === result.id)
  if (fresh) {
    fresh.endedAt   = now
    fresh.summary   = summary
    fresh.decisions = decisions
    fresh.learned   = learned
    fresh.nextSteps = nextSteps
    saveEntity(fresh['@id'], fresh, newGraph)
  }
  return { ok: true, id: result.id, endedAt: now }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function heartbeat({ summary, context, learned = [], nextSteps = [] }) {
  requireMode('local')
  const graph    = await loadGraph()
  const sessions = allEntitiesOfType('Session', graph)
  const open = sessions
    .filter(s => s.startedAt && !s.endedAt)
    .sort((a, b) => b.startedAt > a.startedAt ? 1 : -1)[0]

  if (!open) return { ok: false, reason: 'no open session' }

  open.heartbeat = {
    at:        new Date().toISOString(),
    summary:   summary   || '',
    context:   Array.isArray(context) ? context : (context ? [context] : []),
    learned:   Array.isArray(learned)   ? learned   : [],
    nextSteps: Array.isArray(nextSteps) ? nextSteps : [],
  }
  saveEntity(open['@id'], open, graph)
  return { ok: true, id: open['@id'] }
}

// ── Note / Goal ───────────────────────────────────────────────────────────────

async function addNote(text) {
  requireMode('local')
  const graph    = await loadGraph()
  const sessions = allEntitiesOfType('Session', graph)
  const open = sessions
    .filter(s => s.startedAt && !s.endedAt)
    .sort((a, b) => b.startedAt > a.startedAt ? 1 : -1)[0]

  if (!open) return { ok: false, reason: 'no open session' }

  open.notes = open.notes || []
  open.notes.push({ at: new Date().toISOString(), text })
  saveEntity(open['@id'], open, graph)
  return { ok: true }
}

async function upsertGoal(text) {
  requireMode('local')
  const graph = await loadGraph()
  const id    = `meta_goal_${text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`

  if (graph.entities[id]) {
    const entity = loadEntity(id, graph)
    entity.description = text
    entity.metadata.dateModified = new Date().toISOString().slice(0, 10)
    saveEntity(id, entity, graph)
    return { ok: true, id, updated: true }
  }

  writeEntity({ '@type': 'DefinedTerm', '@id': id, name: text, description: text, tags: ['meta/goal'] }, graph)
  const { scribe } = require('./grim-scribe')
  scribe()
  return { ok: true, id, created: true }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatBriefing(b) {
  console.log('\n  ░ SAVESTATE — Loading...\n')

  if (b.interruptedSession) {
    const s = b.interruptedSession
    console.log(`  ⚡ INTERRUPTED SESSION DETECTED`)
    console.log(`     ${s['@id']}`)
    console.log(`     Topic   : ${s.topic || '?'}`)
    console.log(`     Started : ${s.startedAt}`)
    if (s.heartbeat) {
      console.log(`     Last HB : ${s.heartbeat.at}`)
      console.log(`     State   : ${s.heartbeat.summary || '?'}`)
    }
    console.log()
  }

  if (b.agentModel) {
    console.log(`  Identity : ${b.agentModel.name || 'Grimoire'}`)
    const id = b.agentModel.identity || {}
    if (id.role) console.log(`  Role     : ${id.role}`)
  }

  if (b.userModel?.identity?.name) {
    console.log(`  User     : ${b.userModel.identity.name} (${b.userModel.identity.role || ''})`)
  }

  if (b.recentDreams?.length) {
    console.log(`\n  Recent dreams:`)
    for (const d of b.recentDreams) {
      console.log(`    • ${d.name}: ${(d.summary || d.description || '').slice(0, 80)}`)
    }
  }

  if (b.techniques?.length) {
    console.log(`\n  Cheat codes (${b.techniques.length}):`)
    for (const t of b.techniques.slice(0, 5)) {
      console.log(`    • ${t.name}`)
    }
    if (b.techniques.length > 5) console.log(`    … and ${b.techniques.length - 5} more`)
  }

  if (b.activeGoals?.length) {
    console.log(`\n  Active goals:`)
    for (const g of b.activeGoals) {
      console.log(`    • ${g.name || g.description}`)
    }
  }

  console.log(`\n  Personas: ${(b.personas || []).map(p => p.name).join(', ')}\n`)
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const sub  = process.argv[2]
  const args = minimist(process.argv.slice(3), {
    boolean: ['json'],
    alias:   { j: 'json' },
    string:  ['topic', 'summary', 'context'],
  })

  requireMode('any')

  switch (sub) {
    case 'load': {
      const briefing = await loadBriefing()
      if (args.json) console.log(JSON.stringify(briefing, null, 2))
      else           formatBriefing(briefing)
      break
    }

    case 'save': {
      const summary  = args.summary || args._.join(' ').trim()
      const learned  = args.learned  ? String(args.learned).split(',').map(s => s.trim())  : []
      const next     = args.next     ? String(args.next).split(',').map(s => s.trim())     : []
      const decisions = args.decisions ? String(args.decisions).split(',').map(s => s.trim()) : []
      if (!summary) { console.error('Usage: grim save --summary "..." [--learned "..." --next "..."]'); process.exit(1) }
      const result = await saveSession({ topic: args.topic, summary, learned, nextSteps: next, decisions })
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`  Saved. Session: ${result.id}`)
      break
    }

    case 'start': {
      const topic = args.topic || args._.join(' ').trim() || 'Untitled session'
      const result = await startSession(topic)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`  Session started: ${result.id}`)
      break
    }

    case 'heartbeat': {
      const result = await heartbeat({
        summary:   args.summary || '',
        context:   args.context || '',
        learned:   args.learned  ? String(args.learned).split(',') : [],
        nextSteps: args.next     ? String(args.next).split(',')    : [],
      })
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.ok ? `  Heartbeat saved.` : `  ${result.reason}`)
      break
    }

    case 'note': {
      const text = args._.join(' ').trim()
      if (!text) { console.error('Usage: grim-session note <text>'); process.exit(1) }
      const result = await addNote(text)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.ok ? '  Note added.' : `  ${result.reason}`)
      break
    }

    case 'goal': {
      const text = args._.join(' ').trim()
      if (!text) { console.error('Usage: grim-session goal <text>'); process.exit(1) }
      const result = await upsertGoal(text)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.ok ? `  Goal: ${result.id}` : '  Failed')
      break
    }

    default:
      console.error('Usage: grim load | grim save | grim-session start|heartbeat|note|goal')
      process.exit(1)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })

module.exports = { loadBriefing, startSession, saveSession, heartbeat, addNote, upsertGoal }
