'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { search, enrichWithContext } = require('../bin/grim-oracle')

// ── Minimal graph fixture ─────────────────────────────────────────────────────

function makeGraph(extra = {}) {
  return {
    entities: {
      person_alice: { '@id': 'person_alice', '@type': 'Person', name: 'Alice', description: 'engineer', tags: ['domain/backend'], relationships: { works_on: ['project_alpha'] } },
      person_bob:   { '@id': 'person_bob',   '@type': 'Person', name: 'Bob',   description: 'designer',  tags: ['domain/frontend'], relationships: { works_on: ['project_beta'] } },
      project_alpha: { '@id': 'project_alpha', '@type': 'Project', name: 'Alpha', description: 'backend service', tags: ['domain/backend'], relationships: {} },
      project_beta:  { '@id': 'project_beta',  '@type': 'Project', name: 'Beta',  description: 'frontend app',    tags: ['domain/frontend'], relationships: {} },
      ...extra,
    },
    tags: {
      'domain/backend':  ['person_alice', 'project_alpha'],
      'domain/frontend': ['person_bob', 'project_beta'],
    },
    index: {
      'alice': 'person_alice',
      'bob':   'person_bob',
    },
    backlinks: {
      project_alpha: ['person_alice'],
      project_beta:  ['person_bob'],
    },
  }
}

// ── search: basic query ───────────────────────────────────────────────────────

test('search: exact name match scores 100', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'alice' })
  assert.equal(results.length, 1)
  assert.equal(results[0].entity['@id'], 'person_alice')
  assert.equal(results[0].score, 100)
})

test('search: partial name match returns result', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'alic' })
  const found = results.find(r => r.entity['@id'] === 'person_alice')
  assert.ok(found, 'should find alice on partial name match')
  assert.ok(found.score >= 80, 'starts-with gets score ≥ 80')
})

test('search: description match returns lower score', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'engineer' })
  const found = results.find(r => r.entity['@id'] === 'person_alice')
  assert.ok(found, 'should find alice by description')
  assert.ok(found.score < 80, 'description match scores < 80')
})

test('search: no query, no tag, no type → empty results', () => {
  const graph = makeGraph()
  const results = search(graph, {})
  assert.equal(results.length, 0)
})

// ── search: tag and type filters ──────────────────────────────────────────────

test('search: tag filter returns only tagged entities', () => {
  const graph = makeGraph()
  const results = search(graph, { tag: 'domain/backend' })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(ids.includes('person_alice'))
  assert.ok(ids.includes('project_alpha'))
  assert.ok(!ids.includes('person_bob'))
})

test('search: type filter returns only matching type', () => {
  const graph = makeGraph()
  const results = search(graph, { type: 'person' })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(ids.includes('person_alice'))
  assert.ok(ids.includes('person_bob'))
  assert.ok(!ids.includes('project_alpha'))
})

test('search: limit is respected', () => {
  const graph = makeGraph()
  const results = search(graph, { type: 'person', limit: 1 })
  assert.equal(results.length, 1)
})

// ── search: depth traversal ───────────────────────────────────────────────────

test('search: depth 1 includes related entities', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'alice', depth: 1 })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(ids.includes('person_alice'), 'seed result included')
  assert.ok(ids.includes('project_alpha'), 'outgoing relationship followed')
})

test('search: depth 0 does not follow relationships', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'alice', depth: 0 })
  const ids = results.map(r => r.entity['@id'])
  assert.equal(ids.length, 1)
  assert.ok(!ids.includes('project_alpha'))
})

test('search: hop-1 entities have lower score than seed', () => {
  const graph = makeGraph()
  const results = search(graph, { query: 'alice', depth: 1 })
  const alice   = results.find(r => r.entity['@id'] === 'person_alice')
  const alpha   = results.find(r => r.entity['@id'] === 'project_alpha')
  assert.ok(alice.score > alpha.score, 'seed outscores hop-1 entity')
})

// ── search: --active flag ─────────────────────────────────────────────────────

test('search: active=false traverses expired edges', () => {
  const graph = makeGraph({
    person_carol: {
      '@id': 'person_carol', '@type': 'Person', name: 'Carol', description: 'former',
      tags: [], relationships: { works_on: [{ id: 'project_alpha', validUntil: '2019' }] },
    },
  })
  graph.backlinks.project_alpha.push('person_carol')
  const results = search(graph, { query: 'carol', depth: 1, active: false })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(ids.includes('project_alpha'), 'expired edge followed without --active')
})

test('search: active=true skips expired outgoing edges', () => {
  const graph = makeGraph({
    person_carol: {
      '@id': 'person_carol', '@type': 'Person', name: 'Carol', description: 'former',
      tags: [], relationships: { works_on: [{ id: 'project_alpha', validUntil: '2019' }] },
    },
  })
  graph.backlinks.project_alpha.push('person_carol')
  const results = search(graph, { query: 'carol', depth: 1, active: true, asOf: '2025-01-01' })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(!ids.includes('project_alpha'), 'expired edge not followed with --active')
})

test('search: active=true follows current edges', () => {
  const graph = makeGraph({
    person_dave: {
      '@id': 'person_dave', '@type': 'Person', name: 'Dave', description: 'current',
      tags: [], relationships: { works_on: [{ id: 'project_alpha', validFrom: '2022', validUntil: '2030' }] },
    },
  })
  graph.backlinks.project_alpha.push('person_dave')
  const results = search(graph, { query: 'dave', depth: 1, active: true, asOf: '2025-01-01' })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(ids.includes('project_alpha'), 'current edge followed with --active')
})

test('search: active=true skips backlinks where source edge is expired', () => {
  const graph = makeGraph({
    person_carol: {
      '@id': 'person_carol', '@type': 'Person', name: 'Carol', description: 'former',
      tags: [], relationships: { works_on: [{ id: 'project_alpha', validUntil: '2019' }] },
    },
  })
  graph.backlinks.project_alpha.push('person_carol')
  // Start from project_alpha, look back — should not follow carol if her edge is expired
  const results = search(graph, { query: 'alpha', depth: 1, active: true, asOf: '2025-01-01' })
  const ids = results.map(r => r.entity['@id'])
  assert.ok(!ids.includes('person_carol'), 'backlink with expired edge not followed')
})

// ── enrichWithContext ─────────────────────────────────────────────────────────

test('enrichWithContext: outgoing relationships include name and type', () => {
  const graph = makeGraph()
  const result = { entity: graph.entities.person_alice }
  enrichWithContext(result, graph)
  const outgoing = result._context.outgoing
  assert.ok(outgoing.works_on, 'works_on key present')
  assert.equal(outgoing.works_on.length, 1)
  assert.equal(outgoing.works_on[0].id,   'project_alpha')
  assert.equal(outgoing.works_on[0].name, 'Alpha')
  assert.equal(outgoing.works_on[0].type, 'Project')
})

test('enrichWithContext: incoming backlinks resolved with relType', () => {
  const graph = makeGraph()
  const result = { entity: graph.entities.project_alpha }
  enrichWithContext(result, graph)
  const incoming = result._context.incoming
  assert.equal(incoming.length, 1)
  assert.equal(incoming[0].id,      'person_alice')
  assert.equal(incoming[0].relType, 'works_on')
})

test('enrichWithContext: temporal fields preserved on rich edges', () => {
  const graph = makeGraph({
    person_dave: {
      '@id': 'person_dave', '@type': 'Person', name: 'Dave', description: 'dated',
      tags: [], relationships: { works_on: [{ id: 'project_alpha', validFrom: '2022', validUntil: '2025' }] },
    },
  })
  graph.backlinks.project_alpha.push('person_dave')
  const result = { entity: graph.entities.person_dave }
  enrichWithContext(result, graph)
  const edge = result._context.outgoing.works_on[0]
  assert.equal(edge.validFrom,  '2022')
  assert.equal(edge.validUntil, '2025')
})
