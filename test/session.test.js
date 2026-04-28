'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { decayAffect, labelAffect, AFFECT_BASELINE, AFFECT_DECAY_RATE } = require('../bin/grim-session')

// ── labelAffect ───────────────────────────────────────────────────────────────

test('labelAffect: high valence + high arousal → engaged and building', () => {
  assert.equal(labelAffect(0.8, 0.7), 'engaged and building')
})

test('labelAffect: high valence + low arousal → satisfied and settled', () => {
  assert.equal(labelAffect(0.8, 0.3), 'satisfied and settled')
})

test('labelAffect: mid valence + high arousal → focused', () => {
  assert.equal(labelAffect(0.5, 0.7), 'focused')
})

test('labelAffect: mid valence + low arousal → neutral', () => {
  assert.equal(labelAffect(0.5, 0.3), 'neutral')
})

test('labelAffect: low valence + high arousal → frustrated but pushing', () => {
  assert.equal(labelAffect(0.1, 0.7), 'frustrated but pushing')
})

test('labelAffect: low valence + low arousal → drained', () => {
  assert.equal(labelAffect(0.1, 0.2), 'drained')
})

// ── decayAffect ───────────────────────────────────────────────────────────────

function makeAffect(v, a, d, daysAgo) {
  const date = new Date(Date.now() - daysAgo * 86400000)
  return { valence: v, arousal: a, dominance: d, label: labelAffect(v, a), lastUpdated: date.toISOString() }
}

test('decayAffect: returns unchanged affect when no lastUpdated', () => {
  const affect = { valence: 0.9, arousal: 0.8, dominance: 0.7 }
  assert.equal(decayAffect(affect), affect)
})

test('decayAffect: returns unchanged affect for trivial gap (< 0.1 days)', () => {
  // Use full ISO datetime so elapsed time is genuinely ~0 seconds
  const affect = { valence: 0.9, arousal: 0.8, dominance: 0.7, lastUpdated: new Date().toISOString() }
  const result = decayAffect(affect, new Date())
  assert.equal(result, affect)
})

test('decayAffect: moves values toward baseline after 1 day', () => {
  const affect = makeAffect(0.9, 0.8, 0.9, 1)
  const result = decayAffect(affect)
  // Values should be closer to baseline than original
  assert.ok(result.valence   < affect.valence,   'valence should decrease toward baseline')
  assert.ok(result.valence   > AFFECT_BASELINE.valence, 'valence should not overshoot baseline')
  assert.ok(result.arousal   < affect.arousal,   'arousal should decrease toward baseline')
  assert.ok(result.dominance < affect.dominance, 'dominance should decrease toward baseline')
})

test('decayAffect: decays negative affect toward baseline too', () => {
  const affect = makeAffect(0.1, 0.2, 0.3, 1)
  const result = decayAffect(affect)
  // Negative affect (below baseline) should increase toward baseline
  assert.ok(result.valence   > affect.valence,   'low valence should increase toward baseline')
  assert.ok(result.arousal   > affect.arousal,   'low arousal should increase toward baseline')
  assert.ok(result.valence   < AFFECT_BASELINE.valence, 'should not overshoot baseline')
})

test('decayAffect: near-baseline after 7 days (< 12% deviation retained)', () => {
  const affect = makeAffect(0.9, 0.9, 0.9, 7)
  const result = decayAffect(affect)
  const expectedFactor = Math.exp(-AFFECT_DECAY_RATE * 7)  // ~0.12
  const expectedValence = AFFECT_BASELINE.valence + (0.9 - AFFECT_BASELINE.valence) * expectedFactor
  assert.ok(Math.abs(result.valence - expectedValence) < 0.02)
})

test('decayAffect: exactly at baseline stays at baseline', () => {
  const affect = makeAffect(
    AFFECT_BASELINE.valence,
    AFFECT_BASELINE.arousal,
    AFFECT_BASELINE.dominance,
    5
  )
  const result = decayAffect(affect)
  assert.equal(result.valence,   AFFECT_BASELINE.valence)
  assert.equal(result.arousal,   AFFECT_BASELINE.arousal)
  assert.equal(result.dominance, AFFECT_BASELINE.dominance)
})

test('decayAffect: includes daysElapsed in result', () => {
  const affect = makeAffect(0.8, 0.7, 0.8, 3)
  const result = decayAffect(affect)
  assert.ok(result.daysElapsed > 0, 'daysElapsed should be positive')
  assert.ok(result.daysElapsed < 4, 'daysElapsed should be ~3 days')
})

test('decayAffect: recalculates label after decay', () => {
  // Start engaged, decay enough to drop into neutral territory
  const affect = makeAffect(0.65, 0.55, 0.7, 14)
  const result = decayAffect(affect)
  // After 14 days, ~1.5% of deviation remains — should be near baseline = neutral
  assert.equal(result.label, labelAffect(result.valence, result.arousal))
})

test('decayAffect: preserves lastUpdated (does not advance to now)', () => {
  const affect = makeAffect(0.8, 0.7, 0.8, 3)
  const result = decayAffect(affect)
  assert.equal(result.lastUpdated, affect.lastUpdated)
})
