#!/usr/bin/env node
'use strict'

/**
 * grim-think.js — Delegate thinking to Ollama
 *
 * Offloads heavy analysis from Claude to local LLMs. Assembles KB context
 * via oracle search, fires the question to Ollama, and returns the result.
 *
 * Claude should use this instead of doing in-context reasoning that would
 * burn the context window.
 *
 * CLI:
 *   grim think "what patterns exist in the nixe cluster?"
 *   grim think "suggest relationships for orphan entities" --context "orphan nixe"
 *   grim think "analyze futuristica architecture" --deep --write
 *   grim think "what should we work on next?" --persona gm --write
 *
 * Options:
 *   --context <query>    Oracle search query to pull relevant KB context
 *   --persona <name>     System prompt persona: gm|oracle|crawler|glitch (default: gm)
 *   --deep               Use dreaming model (slower, more thorough)
 *   --write              Post result to noise floor
 *   --json               Ask Ollama to respond in JSON
 *   --timeout <ms>       Ollama timeout (default: 120000)
 */

const minimist = require('minimist')
const { ask }       = require('./model-ask')
const { search }    = require('./grim-oracle')
const { loadGraph } = require('../lib/graph')

// Grimoire task personas
const PERSONAS = {
  gm:       `You are the GM — the Game Master of this knowledge graph. You think in systems and consequences. You find patterns others miss. You are concise and direct.`,
  oracle:   `You are the Oracle. You answer questions about the KB with precision. You surface connections. You do not speculate beyond the evidence.`,
  crawler:  `You are THE CRAWLER. You extract structure from noise. You find entities, relationships, and patterns. You are systematic.`,
  glitch:   `You are GLITCH. You review code and systems for bugs, root causes, and structural problems. You think in failure modes.`,
  savestate:`You are SAVESTATE. You summarize, compress, and preserve continuity. You write for sessions that haven't seen what came before.`,
  // Council expert personas — single-voice mode (no debate, just that expert's take)
  builder:  `You are THE BUILDER. You find what's worth building on, reusable, and leverageable. Pragmatic, not cheerful. Be specific.`,
  skeptic:  `You are THE SKEPTIC. You find what's wrong, what's being hidden, what will bite later. Precise, not contrarian. Be specific.`,
  theorist: `You are THE THEORIST. You identify patterns across time and domain. Connect what you see to larger movements. Be specific.`,
  historian:`You are THE HISTORIAN. You reconstruct why decisions were made — constraints, team, deadlines, pivots. Be specific.`,
  commando: `You are THE COMMANDO. Identify the single mission-critical finding. No preamble. No diplomacy. Lead with the kill shot.`,
}

function buildContextSection(results) {
  if (!results || !results.length) return ''
  const lines = results.slice(0, 8).map(({ entity: e }) =>
    `  [${e['@id']}] ${e['@type']} — ${e.name}: ${(e.description || '').slice(0, 120)}`
  )
  return `\nRELEVANT KB CONTEXT:\n${lines.join('\n')}\n`
}

async function think({ question, contextQuery, persona = 'gm', deep = false, json = false, timeout = 120000 }) {
  // default: linking (gemma4:26b, no thinking, 43 t/s) — fast for interactive use
  // --deep:  dreaming (qwen3.6:27b, thinking, best ceiling) — for synthesis/analysis
  const task   = deep ? 'dreaming' : 'linking'
  const system = PERSONAS[persona] || PERSONAS.gm

  let contextSection = ''
  if (contextQuery) {
    try {
      const graph   = await loadGraph()
      const results = search(graph, { query: contextQuery, limit: 8 })
      contextSection = buildContextSection(results)
    } catch {
      // oracle unavailable — proceed without context
    }
  }

  const prompt = contextSection
    ? `${contextSection}\nQUESTION:\n${question}`
    : question

  const result = await ask({ prompt, task, system, json, timeout })
  return { result, contextUsed: !!contextSection }
}

module.exports = { think }

if (require.main === module) {
  const args = minimist(process.argv.slice(2), {
    boolean: ['deep', 'write', 'json', 'background'],
    string:  ['context', 'persona'],
    default: { persona: 'gm', deep: false, write: false, json: false, background: false, timeout: 120000 },
  })

  // Strip the 'think' subcommand if called via grim dispatcher
  const questionParts = args._.filter(a => a !== 'think')
  const question = questionParts.join(' ').trim()

  if (!question) {
    console.error('Usage: grim think "<question>" [--context "<search query>"] [--deep] [--write] [--background] [--persona gm|oracle|crawler|glitch]')
    process.exit(1)
  }

  // Fire-and-forget: spawn a detached child with --write, return immediately
  if (args.background) {
    const { spawn } = require('node:child_process')
    const childArgs = process.argv.slice(2).filter(a => a !== '--background')
    if (!childArgs.includes('--write')) childArgs.push('--write')

    const child = spawn(process.execPath, [__filename, ...childArgs], {
      detached: true,
      stdio:    'ignore',
      env:      process.env,
    })
    child.unref()

    const preview = question.length > 70 ? question.slice(0, 70) + '...' : question
    console.log(`→ thinking in background`)
    console.log(`  "${preview}"`)
    console.log(`  result → noise floor when done`)
    process.exit(0)
  }

  async function main() {
    const spinner = setInterval(() => process.stderr.write('.'), 2000)

    try {
      const { result, contextUsed } = await think({
        question,
        contextQuery: args.context,
        persona:      args.persona,
        deep:         args.deep,
        json:         args.json,
        timeout:      Number(args.timeout) || 120000,
      })

      clearInterval(spinner)
      process.stderr.write('\n')

      if (contextUsed) console.error('(KB context injected)')

      console.log(result)

      if (args.write) {
        const axios  = require('axios')
        const { config } = require('../lib/env')
        const host = process.env.GRIMOIRE_HOST || `http://${config.host || 'aid:3663'}`
        try {
          await axios.post(`${host}/noise-floor/think`, {
            type: 'reflection',
            text: result.slice(0, 500),
          }, { timeout: 4000 })
          console.error('→ written to noise floor')
        } catch {
          // server offline — result was already printed
        }
      }
    } catch (e) {
      clearInterval(spinner)
      process.stderr.write('\n')
      console.error('grim think failed:', e.message)
      process.exit(1)
    }
  }

  main()
}
