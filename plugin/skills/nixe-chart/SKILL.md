---
name: nixe-chart
description: Use when the user wants to visualize numeric data, training loss, log metrics, or any tabular data using the nixe ASCII chart tools (achart.sh, epoch-loss.sh, quick_maths.sh).
version: 0.1.0
allowed-tools: [Bash, Read]
---

# NIXE:CHART — ASCII Data Visualization

You know the nixe data tools. Default to showing data visually — don't just print numbers.

## The Tools

**achart.sh** — ASCII bar chart from stdin
- Input: 1-column (y values) or 2-column `x y` (labeled bars)
- Scales to terminal width automatically via `tput cols`
- Usage: `some-command | achart.sh`

**epoch-loss.sh** — ML training log visualizer
- Parses logs with epoch/loss format, computes timing, renders ASCII bar chart
- Usage: `cat training.log | epoch-loss.sh`
- Output: offset, epoch index, hours elapsed, percentage, bar

**quick_maths.sh** — summary stats from stdin
- Computes: count, min, max, sum, average, stddev
- Args: `[field_number:1] [precision:2]`
- Usage: `cat data.txt | quick_maths.sh` or `cat data.txt | quick_maths.sh 2 4` (field 2, 4 decimal places)

**hilit.js** — multi-pattern ANSI highlighter
- `some-command | hilit.js pattern1 pattern2 pattern3`
- Each pattern gets a distinct color; use for log scanning

**js-table-to-md.sh** — converts `console.table()` box-drawing output to Markdown table

## When to Use What

| Situation | Tool |
|-----------|------|
| Visualize any list of numbers | `achart.sh` |
| ML training log with epoch/loss | `epoch-loss.sh` |
| Need min/max/avg of a column | `quick_maths.sh` |
| Highlight patterns in log output | `hilit.js` |
| JS console.table output → docs | `js-table-to-md.sh` |

## Rules

- Always pipe through `quick_maths.sh` first when the user asks "how does X look" about a dataset — stats before chart
- Prefer `epoch-loss.sh` over raw `achart.sh` for anything that looks like training logs
- These tools live in `~/bin` — they're on PATH if the nixe profile is sourced
