'use strict'

/**
 * lib/tags.js — Grimoire canonical tag ontology
 *
 * Tags follow the pattern: namespace/term
 * Entities should prefer tags from this list for consistency and searchability.
 * Free-form tags are allowed but canonical ones improve oracle recall.
 */

const TAGS = {

  // ── Domain ────────────────────────────────────────────────────────────────
  // What field or area this entity belongs to
  'domain/ml':              'Machine learning — general',
  'domain/cv':              'Computer vision / image processing',
  'domain/graphics':        'Rendering, shaders, visual output',
  'domain/audio':           'Audio processing, synthesis',
  'domain/systems':         'Infrastructure, ops, system-level',
  'domain/tooling':         'Developer tools, scripts, CLIs',
  'domain/data':            'Data pipelines, ETL, datasets',
  'domain/ui':              'Frontend, user interfaces',
  'domain/api':             'APIs, integrations, protocols',
  'domain/security':        'Security, auth, cryptography',

  // ── Tech ──────────────────────────────────────────────────────────────────
  // Specific technologies, algorithms, or concepts
  'tech/neural-network':    'Neural networks — general',
  'tech/cnn':               'Convolutional neural network',
  'tech/transformer':       'Transformer / attention architecture',
  'tech/gan':               'Generative adversarial network',
  'tech/diffusion':         'Diffusion model',
  'tech/nerf':              'Neural radiance field / NeRF',
  'tech/glsl':              'GLSL shaders',
  'tech/cuda':              'CUDA / GPU compute',
  'tech/onnx':              'ONNX model format',
  'tech/llm':               'Large language model',
  'tech/embedding':         'Embeddings / vector representations',
  'tech/training':          'Model training process',
  'tech/inference':         'Model inference / serving',
  'tech/image-synthesis':   'Image generation / synthesis',
  'tech/image-reconstruction': 'Reproducing or reconstructing an image from a model',
  'tech/colorspace':        'Color space transforms (RGB, YCbCr, etc.)',
  'tech/compression':       'Data or image compression',
  'tech/graph':             'Graph structures, knowledge graphs',
  'tech/json':              'JSON data format',
  'tech/mcp':               'Model Context Protocol',

  // ── Stack ─────────────────────────────────────────────────────────────────
  // Languages, runtimes, frameworks
  'stack/node':             'Node.js',
  'stack/python':           'Python',
  'stack/cpp':              'C / C++',
  'stack/java':             'Java',
  'stack/bash':             'Shell / bash scripting',
  'stack/pytorch':          'PyTorch',
  'stack/numpy':            'NumPy',
  'stack/express':          'Express.js',
  'stack/ollama':           'Ollama local model runner',

  // ── Status ────────────────────────────────────────────────────────────────
  // Lifecycle / state of work
  'status/active':          'Actively worked on',
  'status/paused':          'Work paused, not abandoned',
  'status/complete':        'Done',
  'status/broken':          'Known broken, needs fix',
  'status/experimental':    'Exploratory, not stable',

  // ── Meta ──────────────────────────────────────────────────────────────────
  // Grimoire-internal entity roles (reserved)
  'meta/agent-model':       'Grimoire agent identity',
  'meta/user-model':        'User preferences and identity',
  'meta/persona':           'A named persona / role',
  'meta/session':           'Work session record',
  'meta/goal':              'Persistent goal',
  'meta/technique':         'A cheat code / reusable technique (HowTo)',
}

/**
 * Suggest matching canonical tags for a free-text query.
 * @param {string} query
 * @returns {string[]} matching tag keys
 */
function suggestTags(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(TAGS)
    .filter(([key, desc]) => {
      const haystack = `${key} ${desc}`.toLowerCase()
      return tokens.some(tok => haystack.includes(tok))
    })
    .map(([key]) => key)
}

/**
 * All canonical tag keys, flat list.
 * @returns {string[]}
 */
function allTags() {
  return Object.keys(TAGS)
}

module.exports = { TAGS, suggestTags, allTags }
