---
name: nixe-image
description: Use when the user wants to generate an image, craft a Stable Diffusion prompt, run a111-image.js, tweak strange-kde.sh, or design a meta-prompting pipeline for image generation.
version: 0.1.0
allowed-tools: [Read, Edit, Bash]
---

# NIXE:IMAGE — Meta-Prompting Image Pipeline

You know this pipeline cold. The goal is always: evocative input → richer SD prompt → better image.

## The Stack

**a111-image.js** — sends txt2img to AUTOMATIC1111 at `http://aid:7860/sdapi/v1/txt2img`
- Key args: `--prompt/-p`, `--negative/-n`, `--steps/-s` (default 33), `--width/-w` (960), `--height/-h` (540)
- Reads prompt from stdin if no `-p` given; outputs the saved PNG path to stdout
- Default negative: `blurry, watermark, out of focus, cropped, missing limbs, extra limbs, ugly, waifu, hentai`

**ask-ollama.js** — sends a prompt + system prompt to Ollama at `http://aid:11434`
- `-s` = system prompt, `-p` = user prompt; can also read from stdin

**strange-kde.sh** — the full loop:
1. Random word from `~/txt/words.txt`
2. `ask-ollama.js -s "$PHRASE" -p $word` → evocative phrase
3. `echo $phrase | ask-ollama.js -s "$SCENE"` → SD prompt
4. `a111-image.js -n "$NEGATIVE"` (reads SD prompt from stdin)
5. `kde-bg.sh $filename` — sets desktop background
6. Sleeps 121 seconds, repeats

## The Meta-Prompting Pattern

The key insight: **LLM as prompt expander, not image describer.**

- Pass 1 (PHRASE prompt): extract emotional/narrative texture from the seed word — keep it terse, no commentary
- Pass 2 (SCENE prompt): translate that texture into a full SD prompt locked to a visual style

The SCENE system prompt is the creative lever. Current styles in the script:
- **Weird Tales / vintage comics**: adventurers, mystics, supernatural, comic book art emphasis
- **Office Space / corporate absurdism**: realistic photography, cubicles, Kafka-esque workplace scenes

## Crafting a New SCENE Prompt

A good SCENE prompt has:
1. **Role declaration**: "You are an expert at writing stable diffusion prompts in the style of X"
2. **Visual reference anchors**: name 2-3 specific works, artists, or visual traditions
3. **Subject vocabulary**: what kinds of subjects/characters belong in this world
4. **Style instruction**: `comic book art` / `realistic photography` / `oil painting` etc.
5. **Output contract**: "You only ever generate a single image prompt and do not describe it or add commentary"

## Rules

- Never suggest NSFW subject matter in prompts
- When editing `strange-kde.sh`, swap the `SCENE` export — keep the old one commented, don't delete it
- If the user wants a one-shot image (not a loop), pipe directly: `echo "your prompt" | a111-image.js`
- If AUTOMATIC1111 is unreachable at `http://aid:7860`, say so — don't silently fail or guess alternate ports
- steps=33 is the sweet spot; don't increase without reason (slow), don't drop below 20 (muddy)
