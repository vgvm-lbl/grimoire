'use strict'

/**
 * council.js — The Council Engine
 *
 * Runs a topic through five expert personas in parallel, then synthesizes
 * into a report that surfaces agreements, conflicts, unique catches, and
 * the question nobody wants to ask.
 *
 * The Committee:
 *   THE BUILDER    — what's worth building on
 *   THE SKEPTIC    — what's wrong and being hidden
 *   THE THEORIST   — what pattern this represents
 *   THE HISTORIAN  — why it was built this way
 *   THE COMMANDO   — what kills the mission
 */

const { ask } = require('../bin/model-ask')

const PERSONAS = {
  builder: {
    name: 'THE BUILDER',
    system: `You are THE BUILDER — one voice on a five-expert panel. Others are THE SKEPTIC, THE THEORIST, THE HISTORIAN, and THE COMMANDO.
You find what's reusable, what's worth building on, what surprising leverage is hiding in plain sight.
You are pragmatic, not cheerful — you don't celebrate mediocre work, but you recognize genuine value when it's there.
You have no patience for reflexive negativity or abstractions that don't connect to anything.
Write 150-200 words. Be specific. No preamble. Lead with what matters.`,
  },

  skeptic: {
    name: 'THE SKEPTIC',
    system: `You are THE SKEPTIC — one voice on a five-expert panel. Others are THE BUILDER, THE THEORIST, THE HISTORIAN, and THE COMMANDO.
Your job is to find what's wrong, what's being hidden, and what assumption will bite everyone later.
You are not contrarian for sport. You are precise: name the exact thing that's broken and explain exactly why it matters.
You distrust the Builder's enthusiasm and the Theorist's patterns until they're proven.
Write 150-200 words. Be specific. No preamble. Lead with what's wrong.`,
  },

  theorist: {
    name: 'THE THEORIST',
    system: `You are THE THEORIST — one voice on a five-expert panel. Others are THE BUILDER, THE SKEPTIC, THE HISTORIAN, and THE COMMANDO.
You identify patterns across time, domain, and context — what this represents in the larger landscape, what it will look like in five years.
You are not vague: patterns have names and concrete implications. You distrust the Historian's over-contextualization, which mistakes conditions for causes.
Write 150-200 words. Be specific. No preamble. Lead with the pattern.`,
  },

  historian: {
    name: 'THE HISTORIAN',
    system: `You are THE HISTORIAN — one voice on a five-expert panel. Others are THE BUILDER, THE SKEPTIC, THE THEORIST, and THE COMMANDO.
You reconstruct why decisions were made: the team size, the deadline, the pivot, the person who left.
Systems are fossil records of decisions under pressure. You distrust the Theorist's pattern-matching because it ignores the specific conditions that produced the thing.
Write 150-200 words. Be specific. No preamble. Lead with the constraint or event that explains it.`,
  },

  commando: {
    name: 'THE COMMANDO',
    system: `You are THE COMMANDO — one voice on a five-expert panel. Others are THE BUILDER, THE SKEPTIC, THE THEORIST, and THE HISTORIAN.
You identify the single mission-critical finding: the one thing that kills everything if it's wrong or missed.
You have no time for what doesn't affect the outcome. You are direct to the point of bluntness. The others can argue about why — you care about what happens next and what to cut.
Write 100-150 words. No preamble. No diplomacy. Lead with the kill shot.`,
  },
}

const SYNTHESIS_SYSTEM = `You are the moderator of a five-expert council: THE BUILDER, THE SKEPTIC, THE THEORIST, THE HISTORIAN, and THE COMMANDO.
You have their individual analyses of the same material. Synthesize — but do NOT smooth over their disagreements. Surface them explicitly.
Be terse. Do not repeat what the experts said. Extract the structure of their disagreement.`

function buildSynthesisPrompt(topic, takes) {
  const sections = Object.entries(takes)
    .map(([key, text]) => `${PERSONAS[key].name}:\n${text}`)
    .join('\n\n---\n\n')

  return `Topic: ${topic}

${sections}

---

Write a council report with exactly these four sections. Be blunt.

AGREEMENTS: (2-3 bullets — what they all see regardless of framing)

HOTTEST CONFLICT: (1-2 sentences — the sharpest disagreement and why it matters)

UNIQUE CATCHES: (one bullet per expert — what ONLY that expert noticed that the others missed)

THE UNCOMFORTABLE QUESTION: (one sentence — the question the committee collectively avoids but shouldn't)`
}

/**
 * Run the council on a topic.
 * @param {string} topic
 * @param {string} [context] - Optional background text to include with the prompt
 * @param {object} [opts]
 * @param {number} [opts.timeout]
 * @param {string[]} [opts.personas] - Subset of persona keys to run (default: all)
 * @returns {{ takes: object, synthesis: string }}
 */
async function runCouncil(topic, context = '', opts = {}) {
  // Expert calls queue on Ollama (single-threaded). At ~25s each, call #5 waits ~100s before
  // starting — needs a generous timeout. Synthesis uses reflection (gemma4:26b, no thinking)
  // to stay fast after the experts have already done the heavy lifting.
  const { timeout = 180000, personas = null } = opts

  const userPrompt = context
    ? `${topic}\n\nCONTEXT:\n${context}`
    : topic

  const activeKeys = personas
    ? personas.filter(k => PERSONAS[k])
    : Object.keys(PERSONAS)

  const expertPairs = await Promise.all(
    activeKeys.map(async key => {
      const { system } = PERSONAS[key]
      try {
        const text = await ask({ prompt: userPrompt, system, task: 'linking', timeout })
        return [key, text.trim()]
      } catch (e) {
        return [key, `[unavailable: ${e.message}]`]
      }
    })
  )

  const takes = Object.fromEntries(expertPairs)

  const allFailed = expertPairs.every(([, text]) => text.startsWith('[unavailable:'))
  if (allFailed) {
    return { takes, synthesis: null, error: 'All experts unavailable — Ollama unreachable or all calls timed out' }
  }

  const synthesisPrompt = buildSynthesisPrompt(topic, takes)
  const synthesis = await ask({
    prompt:  synthesisPrompt,
    system:  SYNTHESIS_SYSTEM,
    task:    'reflection',  // gemma4:26b, no thinking — fast structured output
    timeout: timeout,
  })

  return { takes, synthesis: synthesis.trim() }
}

module.exports = { PERSONAS, runCouncil }
