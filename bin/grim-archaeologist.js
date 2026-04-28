#!/usr/bin/env node
'use strict'

/**
 * grim-archaeologist.js — The Archaeologist
 *
 * Two modes:
 *   Deep dig (new):    grim archaeologist --dig <path> [--hints "..."]
 *   Bulk catalog:      grim archaeologist --source <dir>
 *
 * Deep dig pipeline (token-efficient — Ollama does the heavy lifting):
 *   Phase 1 — Overview:   archaeology/{slug}/overview.md   (14b, fast context grab)
 *   Phase 2 — Per-file:   archaeology/{slug}/files/*.md    (7b, bulk)
 *   Phase 3 — Synthesis:  archaeology/{slug}/final.md      (dreaming/qwen3.5)
 *   Phase 3.5+ — KB pass: handled by Claude (reads final.md, Q&A, writes entities)
 *
 * Individual passes:
 *   grim archaeologist --overview <path>   Run just the overview pass
 *   grim archaeologist --files <path>      Run just the per-file pass
 *   grim archaeologist --synth <path>      Run just the synthesis pass
 */

const fs       = require('node:fs')
const path     = require('node:path')
const os       = require('node:os')
const { execSync } = require('node:child_process')
const minimist = require('minimist')
const { ask }          = require('./model-ask')
const { loadGraph }    = require('../lib/graph')
const { runCouncil }   = require('../lib/council')

// Optional — only used in legacy --source bulk mode
let _ner = null
function ner() {
  if (!_ner) {
    try { _ner = require('../lib/ner-client') } catch { _ner = { nerAvailable: async () => false, extractEntities: async () => [] } }
  }
  return _ner
}
const nerAvailable   = (...a) => ner().nerAvailable(...a)
const extractEntities = (...a) => ner().extractEntities(...a)

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.tox', 'coverage', '.nyc_output', 'vendor', 'target', '.next', '.nuxt',
])

const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.java', '.php', '.sh', '.bash', '.lua', '.sql',
  '.glsl', '.vert', '.frag', '.wgsl', '.hlsl',
  '.cs', '.swift', '.kt', '.scala', '.ex', '.exs', '.erl',
])

const CONFIG_NAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'Makefile', 'makefile',
  'CMakeLists.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'build.gradle',
])

const SKIP_NAMES = /(?:[-.]min\.|\.bundle\.|\.generated\.|\.d\.ts$|lock\.json$|yarn\.lock$|package-lock\.json$)/i

const MAX_FILE_LINES = 500
const MAX_FILES_PER_PASS = 25

// ── Language detection (legacy) ───────────────────────────────────────────────

const LANG_SIGNATURES = [
  { lang: 'JavaScript', exts: ['.js', '.mjs', '.cjs'], configs: ['package.json'] },
  { lang: 'TypeScript', exts: ['.ts', '.tsx'],          configs: ['tsconfig.json'] },
  { lang: 'Python',     exts: ['.py'],                  configs: ['setup.py', 'pyproject.toml', 'requirements.txt'] },
  { lang: 'C',          exts: ['.c', '.h'],             configs: ['Makefile', 'makefile'] },
  { lang: 'C++',        exts: ['.cpp', '.cc', '.cxx', '.hpp'], configs: ['CMakeLists.txt'] },
  { lang: 'Perl',       exts: ['.pl', '.pm'],           configs: [] },
  { lang: 'PHP',        exts: ['.php'],                 configs: [] },
  { lang: 'Ruby',       exts: ['.rb'],                  configs: ['Gemfile'] },
  { lang: 'Java',       exts: ['.java'],                configs: ['pom.xml', 'build.gradle'] },
  { lang: 'Shell',      exts: ['.sh', '.bash'],         configs: [] },
  { lang: 'HTML/CSS',   exts: ['.html', '.htm', '.css'], configs: [] },
  { lang: 'Rust',       exts: ['.rs'],                  configs: ['Cargo.toml'] },
  { lang: 'Go',         exts: ['.go'],                  configs: ['go.mod'] },
  { lang: 'Lua',        exts: ['.lua'],                 configs: [] },
  { lang: 'Pascal',     exts: ['.pas', '.pp'],          configs: [] },
  { lang: 'Basic',      exts: ['.bas', '.frm', '.vb'],  configs: [] },
  { lang: 'Assembly',   exts: ['.asm', '.s'],           configs: [] },
  { lang: 'GLSL',       exts: ['.glsl', '.vert', '.frag'], configs: [] },
]

// ── Shared utilities ──────────────────────────────────────────────────────────

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function archDir(projectDir) {
  const name = path.basename(path.resolve(projectDir))
  // On server: write directly into KB. On clients: stage in /tmp.
  const base = process.env.GRIMOIRE_ROOT
    ? path.join(process.env.GRIMOIRE_ROOT, 'archaeology')
    : path.join(os.tmpdir(), 'grimoire-archaeology')
  return path.join(base, slug(name))
}

async function pushArtifacts(outDir, slugName) {
  const host = process.env.GRIMOIRE_HOST
  if (!host) return

  const axios = require('axios')
  const upload = async (filename, content) => {
    try {
      await axios.post(`${host}/api/archaeology/upload`, { slug: slugName, filename, content },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
    } catch (e) {
      console.warn(`  ⚠ push failed (${filename}): ${e.message}`)
    }
  }

  // Walk the outDir and upload everything
  function walk(dir, base = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), rel)
      else upload(rel, fs.readFileSync(path.join(dir, e.name), 'utf8'))
    }
  }
  walk(outDir)
  console.log(`  → pushed to ${host}`)
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function gitLog(dir) {
  try {
    return execSync('git log --oneline -20', {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    }).trim()
  } catch { return '' }
}

function treeOutput(dir, depth = 2) {
  try {
    return execSync(`find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' -maxdepth ${depth} | sort | head -60`, {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    }).trim()
  } catch { return '' }
}

function readmeLike(dir) {
  const candidates = [
    'README.md', 'README.txt', 'README', 'readme.md',
    'package.json', 'pyproject.toml', 'ABOUT', 'DESCRIPTION',
  ]
  for (const name of candidates) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    try {
      const raw = fs.readFileSync(p, 'utf8').slice(0, 3000)
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(raw)
          return `package.json:\n${JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, scripts: pkg.scripts, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies }, null, 2).slice(0, 2000)}`
        } catch { return `package.json:\n${raw}` }
      }
      return `${name}:\n${raw}`
    } catch {}
  }
  return ''
}

function detectEra(dir) {
  try {
    const oldest = execSync('git log --follow --format="%ai" -- . | tail -1', {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    }).trim()
    if (oldest) return oldest.slice(0, 4)
  } catch {}
  return new Date().getFullYear().toString()
}

// ── File collection ───────────────────────────────────────────────────────────

function collectInterestingFiles(dir, max = MAX_FILES_PER_PASS) {
  const results = []

  function walk(d, depth = 0) {
    if (depth > 5 || results.length >= max) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }

    // Files first, dirs second — prefer files closer to root
    const files = entries.filter(e => e.isFile())
    const dirs  = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name))

    for (const e of files) {
      if (results.length >= max) return
      const base = e.name
      const ext  = path.extname(base).toLowerCase()
      if (SKIP_NAMES.test(base)) continue
      if (!CODE_EXTS.has(ext) && !CONFIG_NAMES.has(base)) continue

      const fullPath = path.join(d, base)
      let content
      try { content = fs.readFileSync(fullPath, 'utf8') } catch { continue }

      const lines = content.split('\n').length
      if (lines > MAX_FILE_LINES) continue

      results.push({
        path:    fullPath,
        rel:     path.relative(dir, fullPath),
        content,
        lines,
      })
    }

    for (const e of dirs) walk(path.join(d, e.name), depth + 1)
  }

  walk(dir)
  return results
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const ARCH_SYSTEM = `You are THE ARCHAEOLOGIST — you excavate old code projects and understand them deeply. Your output is precise, technical, and concise. You find things genuinely fascinating and say so when something is weird or brilliant.`

function buildOverviewPrompt(name, dir, era, gitlog, tree, readme, hints) {
  return `Analyze this code project and write a brief overview (250-350 words) covering:
1. What it does and what problem it solves
2. Language(s), era (~${era}), and maturity
3. Entry points and main directories
4. Notable patterns, key dependencies, or unusual choices
5. Current status (active / archived / abandoned / mid-refactor)
${hints ? `\nUser hints: ${hints}\n` : ''}
Project: ${name}
Path: ${dir}

Git log (recent commits):
${gitlog || '(no git history)'}

Directory structure:
${tree || '(unavailable)'}

${readme || '(no README or package.json found)'}

Write flowing prose, not bullet points. Be precise and direct.`
}

function buildFilePrompt(rel, content, lines) {
  return `Analyze this file concisely (100-150 words total):
- **Purpose:** what does this file do in one sentence?
- **Key parts:** main functions/classes/exports — one line each
- **Notable:** bugs, quirks, non-obvious patterns, dead code, design choices worth flagging
- **Connects to:** other files/modules this depends on or exports to

File: ${rel} (${lines} lines)
\`\`\`
${content}
\`\`\``
}

function buildSynthesisPrompt(name, overview, fileDocs) {
  const fileSection = fileDocs.map(f => `### ${f.rel}\n${f.analysis}`).join('\n\n')

  return `You have analyzed every file in the "${name}" project. Now synthesize a comprehensive report.

Structure your report with these exact sections:

## Summary
One paragraph — what this project is, what it does, its era and status.

## Key Components
Each significant file/module — name, purpose, and how it fits the whole.

## Cross-cutting Patterns
Architecture decisions, recurring idioms, notable choices visible across multiple files.

## Bugs & Quirks
Any bugs, dead code, non-obvious behavior, or surprising findings (cite filename when known).

## Era & Technical Context
What was the state of the art when this was written? What's dated vs. still relevant?

## Suggested KB Entities
List each entity worth recording in Grimoire:
- type: Project|SoftwareApplication|DefinedTerm
- id: project_slug_format
- description: one sentence
- tags: ["domain/x", "tech/y", "status/z"]
- relationships: {related_to: [...], depends_on: [...]}

## Revival Potential
What would it take to modernize or reuse this? What's worth salvaging?

---

Overview:
${overview}

Per-file analyses:
${fileSection}`
}

// ── Pass runners ──────────────────────────────────────────────────────────────

async function runOverview(projectDir, opts = {}) {
  const { hints = '' } = opts
  const name   = path.basename(path.resolve(projectDir))
  const era    = detectEra(projectDir)
  const out    = archDir(projectDir)
  ensureDir(out)

  console.log(`  [1/3] Overview pass — ${name}`)

  const prompt = buildOverviewPrompt(
    name, projectDir, era,
    gitLog(projectDir),
    treeOutput(projectDir),
    readmeLike(projectDir),
    hints,
  )

  const overview = await ask({ prompt, system: ARCH_SYSTEM, task: 'extraction', timeout: 120000 })

  const doc = `# ${name} — Overview\n\n_Generated by The Archaeologist — ${new Date().toISOString()}_\n\n${overview}\n`
  fs.writeFileSync(path.join(out, 'overview.md'), doc, 'utf8')
  console.log(`     → ${path.join(out, 'overview.md')}`)

  return { name, era, overview, outDir: out }
}

async function runFilePass(projectDir, opts = {}) {
  const name   = path.basename(path.resolve(projectDir))
  const out    = archDir(projectDir)
  const filesDir = path.join(out, 'files')
  ensureDir(filesDir)

  // Load overview for system context
  const overviewPath = path.join(out, 'overview.md')
  const overviewCtx  = fs.existsSync(overviewPath)
    ? fs.readFileSync(overviewPath, 'utf8').slice(0, 2000)
    : `Project: ${name}`

  const system = `${ARCH_SYSTEM}\n\nProject context:\n${overviewCtx}`

  const files = collectInterestingFiles(projectDir)
  console.log(`  [2/3] Per-file pass — ${files.length} files`)

  const results = []
  for (const f of files) {
    process.stdout.write(`       ${f.rel} ...`)
    const prompt   = buildFilePrompt(f.rel, f.content, f.lines)
    const analysis = await ask({ prompt, system, task: 'linking', timeout: 60000 })

    const safeRel = f.rel.replace(/[/\\]/g, '__').replace(/[^a-z0-9._-]/gi, '_')
    const docPath = path.join(filesDir, `${safeRel}.md`)
    fs.writeFileSync(docPath, `# ${f.rel}\n\n${analysis}\n`, 'utf8')
    process.stdout.write(` ✓\n`)

    results.push({ rel: f.rel, analysis })
  }

  return { name, files: results, outDir: out }
}

async function runSynthesis(projectDir, opts = {}) {
  const name   = path.basename(path.resolve(projectDir))
  const out    = archDir(projectDir)

  const overviewPath = path.join(out, 'overview.md')
  if (!fs.existsSync(overviewPath)) {
    throw new Error(`overview.md not found — run --overview first`)
  }
  const overview = fs.readFileSync(overviewPath, 'utf8')

  // Load all file analyses
  const filesDir = path.join(out, 'files')
  const fileDocs = []
  if (fs.existsSync(filesDir)) {
    for (const f of fs.readdirSync(filesDir).sort()) {
      const content = fs.readFileSync(path.join(filesDir, f), 'utf8')
      const rel = content.split('\n')[0].replace(/^# /, '')
      const analysis = content.split('\n').slice(2).join('\n').trim()
      fileDocs.push({ rel, analysis })
    }
  }

  console.log(`  [3/3] Synthesis pass — ${fileDocs.length} file analyses + overview`)

  const prompt  = buildSynthesisPrompt(name, overview, fileDocs)
  const final   = await ask({ prompt, system: ARCH_SYSTEM, task: 'dreaming', timeout: 600000 })

  const doc = `# ${name} — Final Analysis\n\n_Generated by The Archaeologist — ${new Date().toISOString()}_\n\n${final}\n`
  fs.writeFileSync(path.join(out, 'final.md'), doc, 'utf8')
  console.log(`     → ${path.join(out, 'final.md')}`)

  return { name, final, outDir: out }
}

// ── Phase 3.5 — Council review ────────────────────────────────────────────────
//
// Five experts review the synthesis before the KB pass. Ollama does the work.
// Output goes to council.md alongside final.md.
//
// Topic frames the review as archaeology critique, not general debate.
// The Skeptic and Commando are especially valuable here — they challenge
// what the synthesis claims is worth keeping.

async function runCouncilReview(name, outDir) {
  const finalPath = path.join(outDir, 'final.md')
  if (!fs.existsSync(finalPath)) return null

  let context = fs.readFileSync(finalPath, 'utf8')
  if (context.length > 8000) context = context.slice(0, 8000) + '\n[... truncated ...]'

  console.log(`  [3.5] Council review — five experts weigh in`)

  const topic = `Archaeology review: "${name}" — Is this synthesis accurate? What's most worth keeping in the KB and what should be questioned?`

  // 5 experts at ~14s each on linking = ~70s, plus synthesis ~30s = ~100s
  // Use 240s to allow for Ollama queue pressure
  const result = await runCouncil(topic, context, { timeout: 240000 })

  if (result.error) {
    console.log(`     ⚠  Council unavailable: ${result.error}`)
    return null
  }

  const { PERSONAS } = require('../lib/council')
  const BAR = '─'.repeat(58)

  const lines = [`# ${name} — Council Review`, ``, `_Generated by The Council — ${new Date().toISOString()}_`, ``]

  for (const [key, text] of Object.entries(result.takes)) {
    const label = PERSONAS[key]?.name || key.toUpperCase()
    lines.push(`## ${label}`, ``, text.trim(), ``)
  }

  if (result.synthesis) {
    lines.push(`## SYNTHESIS`, ``, result.synthesis.trim(), ``)
  }

  fs.writeFileSync(path.join(outDir, 'council.md'), lines.join('\n'), 'utf8')
  console.log(`     → ${path.join(outDir, 'council.md')}`)

  return result
}

async function runDig(projectDir, opts = {}) {
  const name     = path.basename(path.resolve(projectDir))
  const slugName = slug(name)
  console.log(`\n  ⛏  The Archaeologist descends into ${name}\n`)

  await runOverview(projectDir, opts)
  await runFilePass(projectDir, opts)
  const result = await runSynthesis(projectDir, opts)
  await runCouncilReview(name, result.outDir)

  await pushArtifacts(result.outDir, slugName)

  const host = process.env.GRIMOIRE_HOST
  if (host) {
    console.log(`\n  ✓ Dig complete + pushed to ${host}`)
    console.log(`  Backlog: ${host}/api/archaeology/backlog\n`)
  } else {
    console.log(`\n  ✓ Dig complete. Read the synthesis:\n    ${path.join(result.outDir, 'final.md')}\n`)
  }
  console.log(`  Next: /archaeologist reads final.md, asks Q&A, writes KB entities\n`)

  return result
}

// ── Legacy bulk catalog ───────────────────────────────────────────────────────

function scanFiles(dir, depth = 0, maxDepth = 3) {
  const result = { byExt: {}, configs: [], fileCount: 0, dirs: [] }
  if (depth > maxDepth) return result

  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return result }

  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    if (e.isDirectory()) {
      result.dirs.push(e.name)
      const sub = scanFiles(path.join(dir, e.name), depth + 1, maxDepth)
      for (const [ext, n] of Object.entries(sub.byExt)) result.byExt[ext] = (result.byExt[ext] || 0) + n
      result.configs.push(...sub.configs)
      result.fileCount += sub.fileCount
    } else if (e.isFile()) {
      result.fileCount++
      const ext = path.extname(e.name).toLowerCase()
      result.byExt[ext] = (result.byExt[ext] || 0) + 1
      for (const sig of LANG_SIGNATURES) {
        if (sig.configs.includes(e.name)) result.configs.push(e.name)
      }
    }
  }
  return result
}

function detectLanguages(scan) {
  const langs = []
  for (const sig of LANG_SIGNATURES) {
    const extCount = sig.exts.reduce((n, ext) => n + (scan.byExt[ext] || 0), 0)
    const hasConfig = sig.configs.some(c => scan.configs.includes(c))
    if (extCount > 0 || hasConfig) langs.push({ lang: sig.lang, files: extCount, hasConfig })
  }
  return langs.sort((a, b) => b.files - a.files)
}

const STANDARD_DIRS = ['doc', 'lib', 'bin', 'test']

function scaffoldDirs(projectDir, { dryRun = false, verbose = false } = {}) {
  const created = []
  for (const d of STANDARD_DIRS) {
    const full = path.join(projectDir, d)
    if (!fs.existsSync(full)) {
      if (!dryRun) fs.mkdirSync(full, { recursive: true })
      created.push(d)
      if (verbose) console.log(`    + ${d}/`)
    }
  }
  return created
}

async function generateGoals(projectName, context, languages, era, existingEntities = []) {
  const langStr  = languages.slice(0, 3).map(l => l.lang).join(', ') || 'unknown'
  const ctxLines = context ? `\nSource context:\n${context.slice(0, 800)}` : ''
  const kbHint   = existingEntities.length
    ? `\nRelated entities in KB: ${existingEntities.map(e => e.name).join(', ')}`
    : ''

  const prompt = `Analyze this old code project and return a JSON object with these fields:
- "description": one clear sentence of what this project does/did
- "goals": array of 3-5 concrete goals (what it could become, what to modernize, how to leverage it)
- "tags": array of relevant tags (use format: domain/X, tech/X, status/X)
- "relationships": object of edges to other entities (if any obvious connections)
- "era_notes": one sentence on the historical/technical context of the era

Project: ${projectName}
Languages: ${langStr}
Era: ~${era}${ctxLines}${kbHint}

Return ONLY valid JSON. No markdown, no preamble.`

  const raw = await ask({ prompt, system: ARCH_SYSTEM, task: 'extraction', json: true })

  try {
    return JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    try { return JSON.parse(stripped) } catch { return null }
  }
}

async function writeToKB(projectName, projectDir, analysis, languages, era) {
  const resolvedName = projectName === '.' || projectName === ''
    ? path.basename(path.resolve(projectDir))
    : projectName
  const id = `project_${slug(resolvedName)}`

  const entity = {
    '@type':        'Project',
    '@id':          id,
    name:           resolvedName,
    description:    analysis?.description || `Code project from ~${era}`,
    tags:           analysis?.tags        || ['status/archived'],
    relationships:  analysis?.relationships || {},
    metadata: {
      era,
      languages:   languages.slice(0, 5).map(l => l.lang),
      source_path: projectDir,
      goals:       analysis?.goals || [],
      era_notes:   analysis?.era_notes || '',
      crawled_at:  new Date().toISOString(),
    },
  }

  const host = process.env.GRIMOIRE_HOST
  if (host) {
    const axios = require('axios')
    await axios.post(`${host}/api/tome/remember`, entity, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    })
    return { id, created: true, method: 'remote' }
  } else {
    const { writeEntity } = require('../lib/entities')
    const graph = await loadGraph()
    const result = writeEntity(entity, graph)
    return { id, ...result, method: 'local' }
  }
}

function isProjectDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files   = entries.filter(e => e.isFile())
  const hasCode = files.some(e => {
    const ext = path.extname(e.name).toLowerCase()
    return LANG_SIGNATURES.some(s => s.exts.includes(ext)) ||
           LANG_SIGNATURES.some(s => s.configs.includes(e.name))
  })
  return hasCode
}

function findProjects(rootDir, maxDepth = 2) {
  const projects = []

  function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    const hasCode = entries.filter(e => e.isFile()).some(e => {
      const ext = path.extname(e.name).toLowerCase()
      return LANG_SIGNATURES.some(s => s.exts.includes(ext))
    })

    if (hasCode && depth > 0) {
      projects.push(dir)
      return
    }

    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        walk(path.join(dir, e.name), depth + 1)
      }
    }
  }

  walk(rootDir, 0)
  return projects
}

async function analyzeProject(projectDir, opts = {}) {
  const { dryRun = false, verbose = false, scaffoldOnly = false, noGoals = false } = opts
  const projectName = path.basename(path.resolve(projectDir))

  process.stdout.write(`  ⛏  ${projectName} `)

  const scan      = scanFiles(projectDir)
  const languages = detectLanguages(scan)
  const era       = detectEra(projectDir)
  const context   = readmeLike(projectDir)
  const langStr   = languages.slice(0, 2).map(l => l.lang).join(', ') || '?'

  process.stdout.write(`[${langStr}, ~${era}, ${scan.fileCount} files]`)

  const created = scaffoldDirs(projectDir, { dryRun, verbose })
  if (created.length && !verbose) process.stdout.write(` +${created.join('/')}`)

  if (scaffoldOnly) { console.log(''); return { projectName, era, languages, scaffolded: created } }

  let nerHints = []
  if (context && !noGoals && await nerAvailable()) {
    nerHints = await extractEntities(context)
  }

  let analysis = null
  if (!noGoals && context) {
    process.stdout.write(' ...')
    analysis = await generateGoals(projectName, context, languages, era, nerHints)
    process.stdout.write(' ✓')
  }

  if (!dryRun) {
    const result = await writeToKB(projectName, projectDir, analysis, languages, era)
    process.stdout.write(` → KB:${result.id}`)
  }

  console.log('')

  if (verbose && analysis?.goals?.length) {
    for (const g of analysis.goals) console.log(`    → ${g}`)
  }

  return { projectName, era, languages, scaffolded: created, analysis }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function showBacklog() {
  // If GRIMOIRE_HOST set, query the server
  const host = process.env.GRIMOIRE_HOST
  if (host) {
    const axios = require('axios')
    try {
      const res = await axios.get(`${host}/api/archaeology/backlog`, { timeout: 5000 })
      const { backlog } = res.data
      console.log(`\n  ⛏  Archaeology backlog  (${host})\n`)
      const pending = backlog.filter(e => e.status !== 'integrated')
      const done    = backlog.filter(e => e.status === 'integrated')
      if (pending.length) {
        console.log(`  Pending (${pending.length}):`)
        for (const e of pending) console.log(`    ${e.slug.padEnd(35)} [${e.status}]`)
      } else console.log('  No pending items.')
      if (done.length) console.log(`\n  Done (${done.length}): ${done.map(e => e.slug).join(', ')}`)
      console.log()
    } catch (e) { console.error(`  ✗ Could not reach ${host}: ${e.message}`) }
    return
  }

  const archRoot = process.env.GRIMOIRE_ROOT
    ? path.join(process.env.GRIMOIRE_ROOT, 'archaeology')
    : path.join(os.tmpdir(), 'grimoire-archaeology')

  if (!fs.existsSync(archRoot)) {
    console.log('  No archaeology directory found.')
    return
  }

  const slugs   = fs.readdirSync(archRoot).filter(d => fs.statSync(path.join(archRoot, d)).isDirectory())
  const pending = []
  const done    = []

  for (const s of slugs) {
    const dir     = path.join(archRoot, s)
    const hasFinal = fs.existsSync(path.join(dir, 'final.md'))
    const hasQA    = fs.existsSync(path.join(dir, 'qa.md'))
    const hasOvr   = fs.existsSync(path.join(dir, 'overview.md'))

    if (!hasFinal) {
      const status = hasOvr ? 'dig-in-progress' : 'empty'
      pending.push({ slug: s, status, dir })
    } else if (!hasQA) {
      pending.push({ slug: s, status: 'awaiting-kb-pass', dir })
    } else {
      done.push(s)
    }
  }

  console.log(`\n  ⛏  Archaeology backlog  (${archRoot})\n`)

  if (pending.length) {
    console.log(`  Pending KB pass (${pending.length}):`)
    for (const p of pending) {
      console.log(`    ${p.slug.padEnd(35)} [${p.status}]`)
      if (p.status === 'awaiting-kb-pass') console.log(`      ${path.join(p.dir, 'final.md')}`)
    }
  } else {
    console.log('  No pending items.')
  }

  if (done.length) {
    console.log(`\n  Done (${done.length}): ${done.join(', ')}`)
  }

  console.log()
}

async function main() {
  const argOffset = process.argv[2] === 'archaeologist' ? 3 : 2
  const args = minimist(process.argv.slice(argOffset), {
    boolean: ['dry-run', 'verbose', 'scaffold-only', 'no-goals', 'json', 'backlog'],
    alias:   { v: 'verbose', n: 'dry-run', j: 'json', b: 'backlog' },
    string:  ['source', 'dig', 'overview', 'files', 'synth', 'hints'],
  })

  // ── Backlog ──
  if (args.backlog) return showBacklog()

  // ── Deep dig mode ──
  if (args.dig || args.overview || args.files || args.synth) {
    const target = args.dig || args.overview || args.files || args.synth
    if (!fs.existsSync(target)) { console.error(`Not found: ${target}`); process.exit(1) }
    const opts = { hints: args.hints || '' }

    if (args.dig)      return runDig(target, opts)
    if (args.overview) return runOverview(target, opts)
    if (args.files)    return runFilePass(target, opts)
    if (args.synth) {
      const r = await runSynthesis(target, opts)
      await runCouncilReview(path.basename(path.resolve(target)), r.outDir)
      return r
    }
  }

  // ── Legacy bulk mode ──
  const source = args.source || (args._[0] && fs.existsSync(args._[0]) ? args._[0] : null)
  if (!source) {
    console.error('Usage:')
    console.error('  grim archaeologist --dig <path> [--hints "..."]   Deep dig (Ollama pipeline)')
    console.error('  grim archaeologist --backlog                       Show pending KB passes')
    console.error('  grim archaeologist --source <dir>                  Bulk catalog')
    console.error('')
    console.error('Individual passes:')
    console.error('  grim archaeologist --overview <path>')
    console.error('  grim archaeologist --files <path>')
    console.error('  grim archaeologist --synth <path>')
    process.exit(1)
  }

  if (!fs.existsSync(source)) { console.error(`Not found: ${source}`); process.exit(1) }

  const opts = {
    dryRun:       args['dry-run'],
    verbose:      args.verbose,
    scaffoldOnly: args['scaffold-only'],
    noGoals:      args['no-goals'],
  }

  const stat = fs.statSync(source)
  let projectDirs

  if (stat.isFile()) {
    console.error('Pass a directory, not a file.'); process.exit(1)
  } else if (isProjectDir(source)) {
    projectDirs = [source]
  } else {
    projectDirs = findProjects(source)
  }

  if (!projectDirs.length) { console.log('  No code projects found.'); return }

  console.log(`\n  ⛏  The Archaeologist descends. (${projectDirs.length} project${projectDirs.length === 1 ? '' : 's'})\n`)

  const results = []
  for (const dir of projectDirs) {
    try {
      const r = await analyzeProject(dir, opts)
      results.push(r)
    } catch (e) {
      console.error(`  ✗ ${path.basename(dir)}: ${e.message}`)
    }
  }

  console.log(`\n  Excavation complete. ${results.length} project${results.length === 1 ? '' : 's'} cataloged.`)

  const languages = {}
  for (const r of results) {
    for (const l of r.languages || []) languages[l.lang] = (languages[l.lang] || 0) + 1
  }
  const topLangs = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topLangs.length) console.log(`  Languages: ${topLangs.map(([l, n]) => `${l}(${n})`).join(', ')}`)

  const eras = results.map(r => r.era).filter(Boolean).sort()
  if (eras.length) console.log(`  Era span: ${eras[0]} – ${eras[eras.length - 1]}`)
  console.log()

  if (args.json) console.log(JSON.stringify(results, null, 2))
}

module.exports = { runDig, runOverview, runFilePass, runSynthesis, runCouncilReview, analyzeProject, findProjects, detectLanguages, detectEra }

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1) })
