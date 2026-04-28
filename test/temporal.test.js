'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const {
  relTargetId, resolveTarget, isActive, filterActive,
  collectIds, collectActiveIds, fmtBounds,
} = require('../lib/temporal')

// ── relTargetId ───────────────────────────────────────────────────────────────

test('relTargetId: returns string as-is', () => {
  assert.equal(relTargetId('project_foo'), 'project_foo')
})

test('relTargetId: extracts id from rich object', () => {
  assert.equal(relTargetId({ id: 'project_foo', validFrom: '2020' }), 'project_foo')
})

test('relTargetId: returns null for null/undefined', () => {
  assert.equal(relTargetId(null),      null)
  assert.equal(relTargetId(undefined), null)
})

test('relTargetId: returns null for object without id', () => {
  assert.equal(relTargetId({ validFrom: '2020' }), null)
})

// ── resolveTarget ─────────────────────────────────────────────────────────────

test('resolveTarget: normalizes string to full object', () => {
  const r = resolveTarget('project_foo')
  assert.equal(r.id,            'project_foo')
  assert.equal(r.validFrom,     null)
  assert.equal(r.validUntil,    null)
  assert.equal(r.assertionType, 'explicit')
})

test('resolveTarget: preserves temporal fields from rich object', () => {
  const r = resolveTarget({ id: 'project_foo', validFrom: '2020', validUntil: '2023', assertionType: 'inferred' })
  assert.equal(r.validFrom,     '2020')
  assert.equal(r.validUntil,    '2023')
  assert.equal(r.assertionType, 'inferred')
})

test('resolveTarget: defaults assertionType to explicit for rich objects', () => {
  const r = resolveTarget({ id: 'project_foo' })
  assert.equal(r.assertionType, 'explicit')
})

test('resolveTarget: returns null for invalid input', () => {
  assert.equal(resolveTarget(null), null)
  assert.equal(resolveTarget({ validFrom: '2020' }), null)  // no id
})

// ── isActive ──────────────────────────────────────────────────────────────────

test('isActive: no bounds → always active', () => {
  assert.equal(isActive({},               '2020-06-01'), true)
  assert.equal(isActive('project_foo',    '2020-06-01'), true)
})

test('isActive: validFrom only — active on and after', () => {
  assert.equal(isActive({ validFrom: '2020' }, '2020-01-01'), true)
  assert.equal(isActive({ validFrom: '2020' }, '2019-12-31'), false)
})

test('isActive: validUntil only — active on and before', () => {
  assert.equal(isActive({ validUntil: '2022' }, '2022-12-31'), true)
  assert.equal(isActive({ validUntil: '2022' }, '2023-01-01'), false)
})

test('isActive: both bounds — active within range', () => {
  const t = { validFrom: '2020', validUntil: '2023' }
  assert.equal(isActive(t, '2021-06-01'), true)
  assert.equal(isActive(t, '2019-12-31'), false)
  assert.equal(isActive(t, '2024-01-01'), false)
})

test('isActive: exact boundary dates are active', () => {
  const t = { validFrom: '2020-01-01', validUntil: '2023-12-31' }
  assert.equal(isActive(t, '2020-01-01'), true)
  assert.equal(isActive(t, '2023-12-31'), true)
})

test('isActive: month-granularity comparison', () => {
  assert.equal(isActive({ validFrom: '2020-06' }, '2020-06'), true)
  assert.equal(isActive({ validFrom: '2020-06' }, '2020-05'), false)
})

test('isActive: cross-granularity — year vs full date', () => {
  // "2020" < "2020-06-01" lexicographically, so from "2020" means active in June 2020
  assert.equal(isActive({ validFrom: '2020' }, '2020-06-01'), true)
  assert.equal(isActive({ validFrom: '2020' }, '2019-12-31'), false)
})

// ── filterActive ──────────────────────────────────────────────────────────────

test('filterActive: keeps active targets, drops inactive', () => {
  const targets = [
    'project_always',
    { id: 'project_old',    validUntil: '2019' },
    { id: 'project_recent', validFrom:  '2024' },
    { id: 'project_current', validFrom: '2020', validUntil: '2030' },
  ]
  const active = filterActive(targets, '2025-01-01')
  assert.equal(active.length, 3)
  const ids = active.map(t => typeof t === 'string' ? t : t.id)
  assert.ok(ids.includes('project_always'))
  assert.ok(ids.includes('project_recent'))
  assert.ok(ids.includes('project_current'))
  assert.ok(!ids.includes('project_old'))
})

test('filterActive: handles empty array', () => {
  assert.deepEqual(filterActive([], '2025'), [])
})

test('filterActive: handles non-array gracefully', () => {
  assert.deepEqual(filterActive(null,      '2025'), [])
  assert.deepEqual(filterActive(undefined, '2025'), [])
})

// ── collectIds / collectActiveIds ─────────────────────────────────────────────

test('collectIds: extracts ids from mixed array', () => {
  const ids = collectIds(['project_a', { id: 'project_b', validFrom: '2020' }, null])
  assert.deepEqual(ids, ['project_a', 'project_b'])
})

test('collectActiveIds: only ids of currently-active targets', () => {
  const targets = [
    'project_always',
    { id: 'project_old', validUntil: '2019' },
  ]
  const ids = collectActiveIds(targets, '2025')
  assert.deepEqual(ids, ['project_always'])
})

// ── fmtBounds ─────────────────────────────────────────────────────────────────

test('fmtBounds: both bounds → range format', () => {
  assert.equal(fmtBounds({ validFrom: '2020', validUntil: '2023' }), '(2020–2023)')
})

test('fmtBounds: from only', () => {
  assert.equal(fmtBounds({ validFrom: '2020' }), '(from 2020)')
})

test('fmtBounds: until only', () => {
  assert.equal(fmtBounds({ validUntil: '2022' }), '(until 2022)')
})

test('fmtBounds: no bounds → empty string', () => {
  assert.equal(fmtBounds({}),          '')
  assert.equal(fmtBounds('string_id'), '')
})
