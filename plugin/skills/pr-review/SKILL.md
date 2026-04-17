---
name: pr-review
description: Review a pull request using local ollama (qwen2.5-coder). Fetches the PR diff, sends it to a local LLM, presents findings in GLITCH format. No cloud required.
argument-hint: [PR number | URL | omit for current branch]
version: 0.1.0
---

# /pr-review — Local PR Review via Ollama

GLITCH, but running on local iron.

## Arguments

PR number, URL, or omit to auto-detect from current branch: $ARGUMENTS

## Instructions

### 1. Resolve ollama URL

Call `mcp__grimoire__oracle_search` for `meta_user_model`, read `infrastructure.ollamaUrl`.
Default to `http://localhost:11434` if not set. Use this URL for all ollama calls below.

### 2. Get the diff

If $ARGUMENTS is provided:
```bash
gh pr diff $ARGUMENTS
```

If $ARGUMENTS is empty, detect the current branch's PR:
```bash
gh pr view --json number -q .number 2>/dev/null
```
Then `gh pr diff <number>`. If no open PR exists, fall back to:
```bash
git diff main...HEAD
```

### 3. Check model availability

```bash
curl -s <ollamaUrl>/api/tags | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).models.map(m=>m.name).join('\n'))"
```

Prefer `qwen2.5-coder:14b`. Fall back to `phi4:latest`, then `phi3:latest`.

### 4. Review the diff

If the diff is under 6000 chars, send it whole. If larger, split on `diff --git` boundaries and review each file chunk separately.

For each chunk, POST to ollama:
```bash
curl -s <ollamaUrl>/api/generate -d '{
  "model": "<model>",
  "prompt": "You are a strict code reviewer. Review this git diff for: bugs, logic errors, security vulnerabilities, resource leaks, missing error handling, unhandled edge cases. Ignore style, formatting, and naming. Be terse. For each finding use this format:\n\nFILE:LINE — what is wrong\nWhy it matters: one sentence\nFix: one sentence\n\nIf nothing is wrong, say: LGTM.\n\nDiff:\n<DIFF>",
  "stream": false
}'
```

### 5. Present findings

Aggregate all findings. Format:

```
FILE:LINE — what's wrong
Why it matters: ...
Fix: ...
```

If nothing flagged across all chunks: `LGTM. Nothing worth flagging.`

End with one line: `Reviewed by <model> via ollama at <ollamaUrl>`

## Tone

GLITCH energy. Terse. Only real problems. No padding.
