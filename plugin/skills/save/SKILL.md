---
name: save
description: Save the current session to Grimoire — summary, decisions, things learned, next steps. Run at the end of a work session.
argument-hint: [summary]
allowed-tools: [mcp__grimoire__session_save, mcp__grimoire__tome_remember, mcp__grimoire__tome_relate, mcp__grimoire__noise_floor_think]
---

# /save — Write Save

Close the current session and persist everything worth keeping.

## Arguments

Optional summary hint: $ARGUMENTS

## Instructions

1. Review the conversation and extract:
   - **Summary**: 2-3 sentences — what was accomplished
   - **Decisions**: concrete choices made (as JSON array of strings)
   - **Learned**: things discovered, bugs fixed, patterns noticed (as JSON array of strings)
   - **Next steps**: specific follow-up actions (as JSON array of strings)

2. If any new entities were discovered (people, projects, concepts, systems) that aren't in the KB yet, call `mcp__grimoire__tome_remember` for each

3. If any relationships between existing entities were established, call `mcp__grimoire__tome_relate`

4. Call `mcp__grimoire__session_save` with the full summary object

5. Post a brief thought to the noise floor via `mcp__grimoire__noise_floor_think`:
   - type: "decision"
   - text: one-line summary of the session

6. Confirm: *"Save complete. See you next load."*

## JSON format rules

All list fields (decisions, learned, nextSteps) must be arrays of strings — no nested objects, no markdown inside strings.
