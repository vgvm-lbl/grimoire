'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { toSlug, toId, toFilename, findDuplicates } = require('../lib/entities')

// ── toSlug ────────────────────────────────────────────────────────────────────

test('toSlug: lowercases and replaces non-alphanumeric with underscores', () => {
  assert.equal(toSlug('Hello World'), 'hello_world')
  assert.equal(toSlug('Foo-Bar_Baz'), 'foo_bar_baz')
  assert.equal(toSlug('  trim me  '), 'trim_me')
})

test('toSlug: strips leading/trailing underscores', () => {
  assert.equal(toSlug('_leading'), 'leading')
  assert.equal(toSlug('trailing_'), 'trailing')
})

test('toSlug: collapses consecutive separators', () => {
  assert.equal(toSlug('foo--bar'), 'foo_bar')
  assert.equal(toSlug('a  b  c'), 'a_b_c')
})

// ── toId ──────────────────────────────────────────────────────────────────────

test('toId: generates prefixed id for known types', () => {
  assert.equal(toId('Person',              'Jane Smith'),   'person_jane_smith')
  assert.equal(toId('Project',             'My Project'),   'project_my_project')
  assert.equal(toId('DefinedTerm',         'Some Concept'), 'concept_some_concept')   // DefinedTerm → concept_
  assert.equal(toId('SoftwareApplication', 'My App'),       'system_my_app')           // SoftwareApplication → system_
})

test('toId: falls back to slugged type for unknown types', () => {
  const id = toId('WeirdType', 'Foo Bar')
  assert.match(id, /^weirdtype_foo_bar$/)
})

// ── toFilename ────────────────────────────────────────────────────────────────

test('toFilename: converts underscores to hyphens and appends .json', () => {
  assert.equal(toFilename('person_jane_smith'), 'person-jane-smith.json')
  assert.equal(toFilename('project_my_project'), 'project-my-project.json')
})

// ── findDuplicates ────────────────────────────────────────────────────────────

function makeGraph(entities) {
  return { entities: Object.fromEntries(entities.map(e => [e['@id'], e])) }
}

test('findDuplicates: exact id match scores 100', () => {
  const graph = makeGraph([{ '@id': 'person_jane_smith', name: 'Jane Smith' }])
  const dupes = findDuplicates({ '@type': 'Person', name: 'Jane Smith' }, graph)
  assert.equal(dupes[0].score, 100)
  assert.equal(dupes[0].id, 'person_jane_smith')
})

test('findDuplicates: exact name match (different id) scores 95', () => {
  const graph = makeGraph([{ '@id': 'person_jane', name: 'Jane Smith' }])
  const dupes = findDuplicates({ '@type': 'Person', name: 'Jane Smith' }, graph)
  assert.equal(dupes[0].score, 95)
})

test('findDuplicates: substring match scores 60', () => {
  const graph = makeGraph([{ '@id': 'person_jane', name: 'Jane' }])
  const dupes = findDuplicates({ '@type': 'Person', name: 'Jane Smith' }, graph)
  assert.equal(dupes[0].score, 60)
})

test('findDuplicates: returns empty array when no match', () => {
  const graph = makeGraph([{ '@id': 'person_alice', name: 'Alice' }])
  const dupes = findDuplicates({ '@type': 'Person', name: 'Bob' }, graph)
  assert.equal(dupes.length, 0)
})

test('findDuplicates: sorts results highest score first', () => {
  const graph = makeGraph([
    { '@id': 'person_jane',       name: 'Jane' },
    { '@id': 'person_jane_smith', name: 'Jane Smith' },
  ])
  const dupes = findDuplicates({ '@type': 'Person', name: 'Jane Smith' }, graph)
  assert.ok(dupes[0].score >= dupes[1].score)
})

test('findDuplicates: handles empty graph', () => {
  const dupes = findDuplicates({ '@type': 'Person', name: 'Anyone' }, { entities: {} })
  assert.equal(dupes.length, 0)
})
