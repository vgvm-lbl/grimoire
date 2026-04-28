'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { parseVRAM, parseBoxOutput, fmtGPU, fmtServices, BOXES } = require('../bin/grim-rig')

// ── parseVRAM ─────────────────────────────────────────────────────────────────

test('parseVRAM: parses nvidia-smi CSV output', () => {
  const gpu = parseVRAM('Tesla P40, 20100, 4476, 24576')
  assert.equal(gpu.name,  'Tesla P40')
  assert.equal(gpu.used,  20100)
  assert.equal(gpu.free,  4476)
  assert.equal(gpu.total, 24576)
})

test('parseVRAM: trims whitespace from each field', () => {
  const gpu = parseVRAM(' GeForce RTX 4060 Ti ,  2345 ,  13000 ,  16384 ')
  assert.equal(gpu.name, 'GeForce RTX 4060 Ti')
  assert.equal(gpu.used, 2345)
})

test('parseVRAM: returns null for NO_GPU sentinel', () => {
  assert.equal(parseVRAM('NO_GPU'), null)
})

test('parseVRAM: returns null for empty/missing input', () => {
  assert.equal(parseVRAM(''),        null)
  assert.equal(parseVRAM(undefined), null)
  assert.equal(parseVRAM(null),      null)
})

test('parseVRAM: returns null for malformed input', () => {
  assert.equal(parseVRAM('just one field'), null)
  assert.equal(parseVRAM('a,b,c'),          null) // only 3 fields
})

// ── parseBoxOutput ────────────────────────────────────────────────────────────

const testBox = BOXES.find(b => b.host === 'chonko') || BOXES[1]

test('parseBoxOutput: parses gpu + service lines', () => {
  const out = 'Tesla P40, 19600, 4976, 24576\nollama:OK'
  const result = parseBoxOutput(testBox, out)
  assert.equal(result.reachable, true)
  assert.equal(result.gpu.name, 'Tesla P40')
  assert.equal(result.services[0].name, 'ollama')
  assert.equal(result.services[0].up, true)
})

test('parseBoxOutput: marks service down on FAIL', () => {
  const out = 'NO_GPU\nollama:FAIL'
  const result = parseBoxOutput(testBox, out)
  assert.equal(result.gpu, null)
  assert.equal(result.services[0].up, false)
})

test('parseBoxOutput: handles multiple services', () => {
  const box = BOXES.find(b => b.host === 'aid') || BOXES[0]
  const out = 'GeForce RTX 4060 Ti, 2345, 14039, 16384\na1111:OK\ncomfyui:FAIL\nwhisper:OK'
  const result = parseBoxOutput(box, out)
  assert.equal(result.services.length, 3)
  assert.equal(result.services[0].up, true)
  assert.equal(result.services[1].up, false)
  assert.equal(result.services[2].up, true)
})

test('parseBoxOutput: handles empty output gracefully', () => {
  const result = parseBoxOutput(testBox, '')
  assert.equal(result.gpu, null)
  assert.equal(result.services.length, 0)
})

// ── fmtGPU ────────────────────────────────────────────────────────────────────

test('fmtGPU: returns null for null gpu', () => {
  assert.equal(fmtGPU(null), null)
})

test('fmtGPU: formats used/total in GB with percent', () => {
  const s = fmtGPU({ name: 'Tesla P40', used: 20480, free: 4096, total: 24576 })
  assert.match(s, /20\.0\/24\.0 GB/)
  assert.match(s, /83%/)
})

test('fmtGPU: strips NVIDIA vendor prefix', () => {
  const s = fmtGPU({ name: 'NVIDIA GeForce RTX 4060 Ti', used: 1024, free: 15360, total: 16384 })
  assert.ok(!s.includes('NVIDIA '))
  assert.match(s, /GeForce RTX 4060 Ti/)
})

test('fmtGPU: strips AMD vendor prefix', () => {
  const s = fmtGPU({ name: 'AMD Radeon RX 7900', used: 1024, free: 15360, total: 16384 })
  assert.ok(!s.includes('AMD '))
})

// ── fmtServices ───────────────────────────────────────────────────────────────

test('fmtServices: returns null for empty services', () => {
  assert.equal(fmtServices([]), null)
})

test('fmtServices: formats running services with bullet', () => {
  const s = fmtServices([{ name: 'ollama', up: true }])
  assert.match(s, /ollama/)
  assert.match(s, /●/)
})

test('fmtServices: formats stopped services with circle', () => {
  const s = fmtServices([{ name: 'comfyui', up: false }])
  assert.match(s, /○/)
})

test('fmtServices: separates multiple services', () => {
  const s = fmtServices([
    { name: 'a1111', up: true },
    { name: 'whisper', up: false },
  ])
  assert.match(s, /a1111/)
  assert.match(s, /whisper/)
})
