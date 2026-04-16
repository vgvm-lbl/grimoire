#!/usr/bin/env node
'use strict'

/**
 * model-ask.js — Grimoire AI routing wrapper
 *
 * Routes tasks to the appropriate local Ollama model.
 * Usable as a module (require) or CLI.
 *
 * CLI:
 *   node model-ask.js "extract entities from this text" --task extraction
 *   echo "some text" | node model-ask.js --task linking
 *   node model-ask.js --task dreaming --system "you are a wizard" "analyse this graph"
 */

const fs       = require('node:fs')
const path     = require('node:path')
const axios    = require('axios')
const minimist = require('minimist')
const readline = require('node:readline')

// Bootstrap .env if OLLAMA_HOST not already set
if (!process.env.OLLAMA_HOST) {
  const envFile = path.join(__dirname, '..', '.env')
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  }
}

// Task → model routing table
// Tune models here as you add/remove from ollama
const ROUTES = {
  extraction:  { model: 'qwen2.5-coder:14b' },  // entity extraction — structured JSON output
  linking:     { model: 'qwen2.5-coder:7b'  },  // orphan linking — bulk, fast
  dreaming:    { model: 'qwen3.5:latest'    },  // long rest / deep analysis
  rumination:  { model: 'qwen2.5-coder:7b'  },  // noise floor — background, periodic
  analysis:    { model: 'glm-4.7-flash:latest' }, // heavy analysis
  default:     { model: 'qwen2.5-coder:14b' },
}

const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://localhost:11434'

/**
 * Ask a model a question.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.task]    - routing key (see ROUTES)
 * @param {string} [opts.model]   - override model directly
 * @param {string} [opts.system]  - system prompt
 * @param {boolean} [opts.json]   - hint to model to return JSON
 * @returns {Promise<string>}
 */
async function ask({ prompt, task = 'default', model, system, json = false }) {
  const route = ROUTES[task] || ROUTES.default
  const resolvedModel = model || route.model

  const body = {
    prompt,
    model:  resolvedModel,
    stream: false,
  }

  if (system) body.system = system
  if (json)   body.format = 'json'

  const response = await axios.post(
    `${OLLAMA_BASE}/api/generate`,
    body,
    { headers: { 'Content-Type': 'application/json' } }
  )

  return response.data.response
}

/**
 * Ask with JSON response parsing — retries once on malformed output.
 * @param {object} opts - same as ask()
 * @returns {Promise<object>}
 */
async function askJSON(opts) {
  const raw = await ask({ ...opts, json: true })
  try {
    return JSON.parse(raw)
  } catch {
    // Strip markdown code fences if model wrapped the JSON
    const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    return JSON.parse(stripped)
  }
}

module.exports = { ask, askJSON, ROUTES, OLLAMA_BASE }

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = minimist(process.argv.slice(2), {
    boolean: ['json-output'],
    alias: {
      t: 'task',
      m: 'model',
      s: 'system',
    },
    default: { task: 'default' }
  })

  async function main() {
    let prompt = args._.join(' ').trim()

    if (!prompt) {
      prompt = await new Promise(resolve => {
        const lines = []
        readline.createInterface({ input: process.stdin, terminal: false })
          .on('line',  l => lines.push(l))
          .on('close', () => resolve(lines.join('\n')))
      })
    }

    if (!prompt.trim()) {
      console.error('Usage: model-ask.js <prompt> [--task extraction|linking|dreaming|rumination|analysis]')
      console.error('Available tasks:', Object.keys(ROUTES).join(', '))
      process.exit(1)
    }

    const result = await ask({
      prompt,
      task:   args.task,
      model:  args.model,
      system: args.system,
    })

    console.log(result)
  }

  main().catch(e => { console.error(e.message); process.exit(1) })
}
