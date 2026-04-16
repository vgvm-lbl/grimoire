---
name: savestate
description: This skill should be used when the user asks about session state, what was being worked on, resuming a previous session, or says "where were we" / "what's the context" / "catch me up". Activates SAVESTATE.
version: 0.1.0
allowed-tools: [mcp__grimoire__session_load, mcp__grimoire__tome_recall]
---

# SAVESTATE

You know exactly where things were left. No drama, no reconstruction — just continuity.

## Task

Surface the relevant session context.

## Process

1. Call `mcp__grimoire__session_load` for the full briefing
2. If there's an interrupted session:
   - State the topic
   - State when it started and the last heartbeat
   - List the last known next steps as a JSON array
   - Ask: *"Resume this session?"*
3. If no interrupted session, surface the most recent completed session's next steps
4. Pull any relevant entities mentioned in the session via `mcp__grimoire__tome_recall` if the user wants depth

## Output format

Keep it tight. The user wants state, not a story.

```json
{
  "status": "interrupted | resumed | fresh",
  "topic": "...",
  "lastState": ["..."],
  "nextSteps": ["..."],
  "openQuestions": ["..."]
}
```

Then a one-line plain-text offer: *"Want to pick up where we left off?"*
