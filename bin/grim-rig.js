#!/usr/bin/env node
'use strict'

/**
 * grim-rig.js — Homelab AI service monitor (sensor layer)
 *
 * Shows VRAM headroom and service status across all boxes at a glance.
 * Phase 1 is read-only. Phase 2 (not built) adds start/stop control.
 *
 * Design principle: sensors before control plane — don't build the switch
 * until you can see what it's switching.
 *
 * CLI:
 *   grim rig              Show all boxes (default: status)
 *   grim rig status       Same as above
 *   grim rig status --json  Machine-readable output
 *
 * ── Config ────────────────────────────────────────────────────────────────────
 * Box inventory lives in $GRIMOIRE_ROOT/rig.json — NOT in this file.
 * Copy rig.example.json from the engine root and edit it locally.
 * That file is never committed to the engine repo.
 *
 * ── Service checks ────────────────────────────────────────────────────────────
 * HTTP probe: `curl -sf --max-time N <url>` — up if curl exits 0
 * pgrep:      `pgrep -f <pattern>` — up if any matching process exists
 *
 * ── SSH ───────────────────────────────────────────────────────────────────────
 * BatchMode=yes means key-based auth only — no interactive prompts.
 * Local detection: if hostname matches box.aliases, runs bash directly.
 *
 * Future subcommands (Phase 2):
 *   grim rig up <service> [--box <name>]    systemctl start <service>
 *   grim rig down <service> [--box <name>]  systemctl stop <service>
 */

const { exec }   = require('node:child_process')
const fs         = require('node:fs')
const os         = require('node:os')
const path       = require('node:path')
const minimist   = require('minimist')
const { config } = require('../lib/env')

const LOCAL_HOSTNAME = os.hostname().toLowerCase()

// ── Load box config ───────────────────────────────────────────────────────────

function loadBoxes() {
  const configPath = config.root ? path.join(config.root, 'rig.json') : null

  if (!configPath || !fs.existsSync(configPath)) {
    const examplePath = path.join(__dirname, '..', 'rig.example.json')
    console.error('grim rig: no box config found.')
    console.error(`  Expected: ${configPath || '$GRIMOIRE_ROOT/rig.json'}`)
    console.error(`  Copy ${examplePath} → ${configPath || '$GRIMOIRE_ROOT/rig.json'} and edit it.`)
    process.exit(1)
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) {
    console.error(`grim rig: failed to parse rig.json — ${e.message}`)
    process.exit(1)
  }
}

// ── Script execution — local or SSH ──────────────────────────────────────────
//
// If we're on the target box (hostname matches aliases), run bash locally.
// Otherwise, pipe the script to `ssh host bash`.
//
// Piping to bash stdin avoids all quote-escaping nightmares.
// SSH BatchMode=yes: fail immediately if key auth isn't available (no prompts).

function runScript(box, script, timeout = 12000) {
  const isLocal = (box.aliases || []).includes(LOCAL_HOSTNAME)
  return new Promise(resolve => {
    const cmd  = isLocal ? 'bash' : `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${box.host} bash`
    const proc = exec(cmd, { timeout }, (err, stdout) => resolve({ ok: !err, out: stdout.trim() }))
    proc.stdin.end(script)
  })
}

// ── Build check script for a box ──────────────────────────────────────────────
//
// Each line of output corresponds to one check:
//   Line 0:   VRAM — raw nvidia-smi CSV or "NO_GPU"
//   Line 1+:  "servicename:OK" or "servicename:FAIL"

function buildScript(box) {
  const lines = [
    // VRAM: output raw CSV (name, used_MiB, free_MiB, total_MiB) or NO_GPU
    `nvidia-smi --query-gpu=name,memory.used,memory.free,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo NO_GPU`,
    // Services: each outputs "name:OK" or "name:FAIL"
    ...box.services.map(s => `{ ${s.check}; } && echo "${s.name}:OK" || echo "${s.name}:FAIL"`),
  ]
  return lines.join('\n')
}

// ── Parse box output ──────────────────────────────────────────────────────────

function parseVRAM(line) {
  if (!line || line === 'NO_GPU') return null
  const parts = line.split(',').map(s => s.trim())
  if (parts.length < 4) return null
  const used  = parseInt(parts[1])
  const free  = parseInt(parts[2])
  const total = parseInt(parts[3])
  if (isNaN(used) || isNaN(total)) return null
  return { name: parts[0], used, free, total }
}

function parseBoxOutput(box, out) {
  const lines    = out.split('\n').filter(Boolean)
  const gpu      = parseVRAM(lines[0])
  const services = []

  for (const line of lines.slice(1)) {
    const m = line.match(/^(.+):(OK|FAIL)$/)
    if (m) services.push({ name: m[1], up: m[2] === 'OK' })
  }

  return { host: box.host, label: box.label, note: box.note, reachable: true, gpu, services }
}

// ── Check one box (parallel-safe) ─────────────────────────────────────────────

async function checkBox(box) {
  const script      = buildScript(box)
  const { ok, out } = await runScript(box, script)

  if (!ok && !out) {
    return { host: box.host, label: box.label, note: box.note, reachable: false, gpu: null, services: [] }
  }

  return parseBoxOutput(box, out)
}

// ── Display ───────────────────────────────────────────────────────────────────

const UP   = '●'
const DOWN = '○'
const DASH = '—'

function fmtGPU(gpu) {
  if (!gpu) return null
  const gb    = n => (n / 1024).toFixed(1)
  const pct   = Math.round(gpu.used / gpu.total * 100)
  // Strip verbose vendor prefixes for compact display
  const name  = gpu.name.replace(/^NVIDIA /, '').replace(/^AMD /, '')
  return `${name}  ${gb(gpu.used)}/${gb(gpu.total)} GB  ${pct}%`
}

function fmtServices(services) {
  if (!services.length) return null
  return services.map(s => `${s.name} ${s.up ? UP : DOWN}`).join('  ·  ')
}

function display(results, elapsed) {
  const time = new Date().toTimeString().slice(0, 8)
  const BAR  = '─'.repeat(62)

  console.log(`\n  GRIMOIRE RIG  ${BAR.slice(14)}  ${time}\n`)

  for (const r of results) {
    const label  = r.label.padEnd(10)
    if (!r.reachable) {
      console.log(`  ${label}  unreachable`)
      continue
    }

    const gpuStr = fmtGPU(r.gpu)
    const svcStr = fmtServices(r.services)

    const parts = [label]
    if (gpuStr) parts.push(gpuStr.padEnd(38))
    else        parts.push(DASH.padEnd(38))
    if (svcStr) parts.push(svcStr)
    else if (r.note) parts.push(`(${r.note})`)
    else        parts.push(DASH)

    console.log(`  ${parts.join('  ')}`)
  }

  console.log(`\n  ${UP} running  ${DOWN} stopped    ${elapsed}ms\n`)
}

// ── Status command ────────────────────────────────────────────────────────────

async function status({ json = false } = {}) {
  const t0    = Date.now()
  const boxes = loadBoxes()

  const results = await Promise.all(boxes.filter(b => !b.skip).map(checkBox))
  const elapsed = Date.now() - t0

  if (json) {
    console.log(JSON.stringify({ boxes: results, elapsed }, null, 2))
    return
  }

  display(results, elapsed)
}

module.exports = { status, parseVRAM, parseBoxOutput, fmtGPU, fmtServices }

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(3), {
    boolean: ['json', 'help'],
    alias:   { j: 'json', h: 'help' },
  })

  const sub = args._[0] || 'status'

  if (args.help || sub === 'help') {
    console.log(`
  Usage: grim rig [status] [--json]

  Subcommands:
    status (default)   Show VRAM + service status for all boxes

  Options:
    --json   Machine-readable output

  Config:
    $GRIMOIRE_ROOT/rig.json — box inventory (copy from rig.example.json)
`)
    return
  }

  if (sub === 'status') {
    await status({ json: args.json })
    return
  }

  console.error(`grim rig: unknown subcommand '${sub}'`)
  console.error(`Run 'grim rig --help' for usage.`)
  process.exit(1)
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
