'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { buildSynthesisPrompt, PERSONAS } = require('../lib/council')

// ── PERSONAS ──────────────────────────────────────────────────────────────────

test('PERSONAS: has all five expected experts', () => {
  const keys = Object.keys(PERSONAS)
  for (const expected of ['builder', 'skeptic', 'theorist', 'historian', 'commando']) {
    assert.ok(keys.includes(expected), `missing persona: ${expected}`)
  }
})

test('PERSONAS: each persona has name and system fields', () => {
  for (const [key, p] of Object.entries(PERSONAS)) {
    assert.ok(p.name,   `${key} missing name`)
    assert.ok(p.system, `${key} missing system`)
  }
})

test('PERSONAS: commando is shortest (100-150 words, others 150-200)', () => {
  // Commando is the kill-shot persona — instructions say 100-150 words
  assert.match(PERSONAS.commando.system, /100-150 words/)
  assert.match(PERSONAS.builder.system,  /150-200 words/)
})

// ── buildSynthesisPrompt ──────────────────────────────────────────────────────

const fakeTakes = {
  builder:   'The reusable parts are X and Y.',
  skeptic:   'The assumption about Z is wrong.',
  theorist:  'This follows the pattern of W.',
  historian: 'It was built under deadline pressure in 2019.',
  commando:  'The kill shot: Z is broken and will fail in prod.',
}

test('buildSynthesisPrompt: includes the topic', () => {
  const p = buildSynthesisPrompt('is this worth building?', fakeTakes)
  assert.match(p, /is this worth building\?/)
})

test('buildSynthesisPrompt: includes each expert name and take', () => {
  const p = buildSynthesisPrompt('topic', fakeTakes)
  assert.match(p, /THE BUILDER/)
  assert.match(p, /THE SKEPTIC/)
  assert.match(p, /THE THEORIST/)
  assert.match(p, /THE HISTORIAN/)
  assert.match(p, /THE COMMANDO/)
  assert.match(p, /reusable parts/)
  assert.match(p, /assumption about Z/)
})

test('buildSynthesisPrompt: includes all four required output sections', () => {
  const p = buildSynthesisPrompt('topic', fakeTakes)
  assert.match(p, /AGREEMENTS/)
  assert.match(p, /HOTTEST CONFLICT/)
  assert.match(p, /UNIQUE CATCHES/)
  assert.match(p, /UNCOMFORTABLE QUESTION/)
})

test('buildSynthesisPrompt: separates expert takes with divider', () => {
  const p = buildSynthesisPrompt('topic', fakeTakes)
  assert.match(p, /---/)
})

test('buildSynthesisPrompt: handles subset of personas', () => {
  const subsetTakes = { builder: 'Good stuff.', commando: 'Kill shot.' }
  const p = buildSynthesisPrompt('topic', subsetTakes)
  assert.match(p, /THE BUILDER/)
  assert.match(p, /THE COMMANDO/)
  assert.ok(!p.includes('THE SKEPTIC'))
})
