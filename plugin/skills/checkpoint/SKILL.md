---
name: checkpoint
description: Mid-session KB snapshot — write new entities and relationships without closing the session. Use before context compaction to avoid losing discoveries.
argument-hint: [hint]
allowed-tools: [mcp__grimoire__tome_remember, mcp__grimoire__tome_update, mcp__grimoire__tome_relate, mcp__grimoire__scribe, mcp__grimoire__noise_floor_think]
---

# /checkpoint — Mid-Session Snapshot

Persist KB-worthy discoveries from the current session without ending it. Session continues normally after.

## Arguments

Optional hint about what to focus on: $ARGUMENTS

## When to use

- Before context compaction is likely (long sessions, heavy tool use)
- After a significant design decision or architecture discussion
- After ingesting a new project or discovering cross-repo connections
- Any time you want to make sure something survives a compaction

## Instructions

1. Review the conversation since the last /checkpoint or /load and identify:
   - **New entities** worth adding to the KB (projects, concepts, decisions, patterns)
   - **Updated entities** where existing KB entries are now stale or incomplete
   - **New relationships** between existing entities

2. For each new entity: `oracle_search` first to avoid duplicates, then `tome_remember`

3. For each stale entity: `tome_update`

4. For each new relationship: `tome_relate`

5. If any entities were written or updated, call `scribe` to rebuild the index

6. Post a noise floor thought:
   - type: "observation"
   - text: one-line summary of what was checkpointed

7. Confirm: *"Checkpoint saved. Session continues."*

## What NOT to checkpoint

- Things already in the KB and unchanged
- Ephemeral task details (current command output, file contents being edited)
- Anything derivable from reading the code or git history
- The session summary itself — that belongs in /save

## Tone

Quick and surgical. This is a pit stop, not a ceremony.
