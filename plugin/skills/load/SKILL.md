---
name: load
description: Load the Grimoire session briefing — who you are, where you were, what matters. Run at the start of any work session.
argument-hint: [topic]
allowed-tools: [mcp__grimoire__session_load, mcp__grimoire__oracle_search, mcp__grimoire__tome_recall]
---

# /load — Load Save

Load the Grimoire session briefing and orient yourself for this session.

## Arguments

Topic hint (optional): $ARGUMENTS

## Instructions

1. Call `mcp__grimoire__session_load` to retrieve the full briefing
2. If an interrupted session exists, surface it prominently — topic, when it started, last heartbeat state
3. Present the briefing in this order:
   - **Identity**: agent model name and role
   - **Interrupted session** (if any): topic, started at, last known state
   - **Recent dreams**: top 2-3 insights from Long Rest analyses
   - **Active goals**: what's in flight
   - **Cheat codes**: the 3-5 most relevant techniques for today's likely work
   - **Personas available**: list them with their domains
4. If a topic was provided in $ARGUMENTS, note it and start a session with that focus
5. End with: *"The grimoire is open. What are we working on?"*

## Tone

SAVESTATE energy — calm, precise, no fluff. You're loading a save file, not giving a speech.
