'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { unwrapEntities, buildPrompt } = require('../bin/grim-ingest')

// ── unwrapEntities ────────────────────────────────────────────────────────────
// This is the function that handles Ollama's inconsistent JSON output shapes.

test('unwrapEntities: returns bare array unchanged', () => {
  const arr = [{ name: 'Foo' }, { name: 'Bar' }]
  assert.deepEqual(unwrapEntities(arr), arr)
})

test('unwrapEntities: unwraps {"entities": [...]}', () => {
  const val = { entities: [{ name: 'Foo' }] }
  assert.deepEqual(unwrapEntities(val), [{ name: 'Foo' }])
})

test('unwrapEntities: unwraps object with any array-valued key', () => {
  const val = { items: [{ name: 'X' }] }
  assert.deepEqual(unwrapEntities(val), [{ name: 'X' }])
})

test('unwrapEntities: returns [] for null', () => {
  assert.deepEqual(unwrapEntities(null), [])
})

test('unwrapEntities: returns [] for non-array, non-object', () => {
  assert.deepEqual(unwrapEntities('nope'), [])
  assert.deepEqual(unwrapEntities(42),     [])
})

test('unwrapEntities: returns [] for object with no array values', () => {
  assert.deepEqual(unwrapEntities({ foo: 'bar', baz: 42 }), [])
})

test('unwrapEntities: returns [] for empty array', () => {
  assert.deepEqual(unwrapEntities([]), [])
})

// ── buildPrompt ───────────────────────────────────────────────────────────────

test('buildPrompt: includes transcript text', () => {
  const p = buildPrompt('hello world', '', 'auto')
  assert.match(p, /hello world/)
})

test('buildPrompt: includes existing KB context when provided', () => {
  const p = buildPrompt('text', 'EXISTING KB CONTEXT: some entity', 'auto')
  assert.match(p, /EXISTING KB ENTITIES/)
  assert.match(p, /some entity/)
})

test('buildPrompt: omits KB context section when empty', () => {
  const p = buildPrompt('text', '', 'auto')
  assert.ok(!p.includes('EXISTING KB ENTITIES'))
})

test('buildPrompt: includes format hint for chat', () => {
  const p = buildPrompt('text', '', 'chat')
  assert.match(p, /INPUT TYPE/)
  assert.match(p, /chat transcript/)
})

test('buildPrompt: no format hint for auto', () => {
  const p = buildPrompt('text', '', 'auto')
  assert.ok(!p.includes('INPUT TYPE'))
})

test('buildPrompt: truncates long text at 12000 chars', () => {
  const long = 'x'.repeat(15000)
  const p = buildPrompt(long, '', 'auto')
  assert.match(p, /\[... truncated \.\.\.\]/)
  // Should not contain the full 15000-char string
  assert.ok(p.length < 14000)
})

test('buildPrompt: requests {"entities": [...]} wrapper format', () => {
  const p = buildPrompt('text', '', 'auto')
  assert.match(p, /"entities"/)
})
