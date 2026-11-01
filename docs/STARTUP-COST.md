# STARTUP-COST.md — what a seat reads before its first useful sentence

`repoboard cost` (docs/REFERENCE.md §4) measures the files the harness loads by itself. This page is
the other half: what a seat **reads** in its first few tool calls after `you are the <name> seat`,
and four trims that cut it. Everything here was measured in one member repo running five seats on
2026-11-01, from the agents' own session transcripts; the recipe is at the end, so measure yours
before you copy a number.

## What was measured

Context tokens (input + cache) at the moment a seat claimed itself (`seat <name> --up`):

| | tokens at seat-up |
|---|---|
| base, before any read (system prompt, CLAUDE.md, memory index, tools) | ≈47k |
| coordinator | 96.7k |
| builder | 74.1k |
| two other builders | 51.8k, 51.9k |

Almost everything above the base was four reads: the tail of the owner's decisions file (22.8k
chars), memory files opened "to come up" (26k chars for one seat), the day's log (8–16k chars), and
`repoboard state`. After the trims below, the next restart of a seat measured **51.7k** at seat-up,
against 58.7k–75.8k at its four restarts before them.

Past seat-up, a seat's first answer is dominated by its task's own reads (one builder: 51.8k at
seat-up, 124.3k at its first answer, from reading its task's code and log blocks). No start-up
trim touches that; it is a separate lever.

## The four trims — put them in your CLAUDE.md "start here"

1. **Decisions: headlines, not the file.** If the owner's decisions live in an append-only file,
   read the newest rows' first characters, not the rows: `tail -n 30 <decisions file> | cut -c1-240`.
   Before acting on one, `grep -n` it by its id and read that row whole. Measured 22.8k → 7.2k
   chars. It works because rows are written headline first; a row whose first 240 characters do
   not say what was decided defeats it.
2. **Memory: open none to come up.** The harness already loads the memory index into context. A
   seat opens a memory file only when the task in hand needs it (arming a watcher → the watcher
   file; standing down → the lifecycle file), and reads only the part it needs.
3. **A short memory index whose hooks say WHEN.** One line per memory file, and the line names the
   moment to open it ("about to run the test suite"), not a summary of what it says. Trim the
   biggest files to their rules, keeping every command, path and threshold. Measured: index
   10.2 → 4.9 KB, the two biggest files 14 → 10–12 KB. Check a trim by content, not by eye: the
   set of `[[links]]`, the index's file pointers and the count of each threshold and command
   literal must be equal before and after.
4. **The log: your part only.** `repoboard seat <name>` already prints your last block and the
   coordinator's. Add `repoboard inbox <name>` (what other seats addressed to you and you have not
   ACKed) and the broadcasts inbox does not list:
   `grep -n -E '^(ALL SEATS|EVERY SEAT)' <log dir>/<yesterday>.md <log dir>/<today>.md`.
   Open the day's log only for a block one of those points at
   (`repoboard log show --since <HH:MMZ>` for a window). Measured ≈1.5k chars against 8–16k. The
   rule this needs: every broadcast keeps one line that starts with the marker you grep for.

## Two traps

- **An oversized read arrives as a preview.** Claude Code saves a tool result over its size limit
  to a file and shows the agent a short preview (≈2 KB) plus the path. A STATE file grown past the
  limit is seen as its first lines only: the seat either misses what sits below them (seats, the
  owner queue) or reads the file again in parts and pays twice. Keep `repoboard state` well under
  the limit: LIVE one value per row, LAST LANDINGS short, history in the log (docs/AGENTS.md §8, STATE shape rules).
- **Append-only files shrink only on a schedule.** A decisions file, a known-issues list and LAST
  LANDINGS grow with every day of work; a one-time cut by hand does not hold. What held: a
  recurring archive (weekly) that moves rows **verbatim** — never summarised, so nothing is lost
  and a grep still finds it — to a dated archive file. The rows that move are the ones that no
  longer decide anything: one-off go-aheads already carried out, rules a later row replaced,
  references to things that no longer exist. `repoboard archive` does this for cards; for the
  files, make it a recurring card.

## Measuring it yourself

Save this as `seatup-cost.py` anywhere outside the repo and run
`python3 -I seatup-cost.py --dir <folder> [seat] [--top]`. `<folder>` is the one Claude Code keeps
this repo's session transcripts in (one `.jsonl` file per session; the folder's name is the repo's
absolute path with every non-alphanumeric character turned into `-`). The script finds each typed
`you are the <seat> seat` and prints the seconds and tokens at that seat's own `seat <seat> --up`
call and at its first end-of-turn answer. `--top` adds the five
biggest tool results of each start-up, which is where the trims above came from. Read-only. Run it
again after each change: the number moves with the day's task, so compare restarts of the same seat.

```python
# seatup-cost.py: for each "you are the <seat> seat" start in this repo's recent Claude Code transcripts, the seconds and
# context tokens (input + cache) at the seat's own `seat <seat> --up` call and at its first end-of-turn answer.
# Read-only. Usage: python3 -I seatup-cost.py --dir <this repo's Claude Code transcript folder> [seat] [--top]
import json, glob, os, re, sys
from datetime import datetime

args = sys.argv[1:]
top = '--top' in args
if '--dir' not in args or args.index('--dir') + 1 >= len(args):
    sys.exit("usage: python3 -I seatup-cost.py --dir <this repo's Claude Code transcript folder> [seat] [--top]")
d = args[args.index('--dir') + 1]
rest = [a for i, a in enumerate(args) if a != '--top' and a != '--dir' and (i == 0 or args[i - 1] != '--dir')]
want = rest[0] if rest else ''

def when(r): return datetime.fromisoformat(r['timestamp'].replace('Z', '+00:00'))
def tokens(r):
    u = r['message'].get('usage', {})
    return u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)
def text(c):
    if isinstance(c, str): return c
    return ' '.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''

out = []
for f in sorted(glob.glob(d + '/*.jsonl'), key=os.path.getmtime)[-80:]:
    rows = [json.loads(l) for l in open(f, encoding='utf-8', errors='replace') if l.strip()]
    for i, r in enumerate(rows):
        m = re.match(r'\s*you are the ([a-z-]+) seat', text((r.get('message') or {}).get('content')))
        if r.get('type') != 'user' or not m or (want and m.group(1) != want): continue
        seat, up, answer, calls, reads = m.group(1), None, None, {}, {}
        for r2 in rows[i + 1:]:
            c2 = (r2.get('message') or {}).get('content')
            if r2.get('type') == 'user' and isinstance(c2, str): break  # the next typed prompt ends the start-up
            if r2.get('type') == 'user' and isinstance(c2, list):
                for x in c2:
                    if x.get('type') == 'tool_result':
                        b = x.get('content'); reads[calls.get(x.get('tool_use_id'), '?')] = len(b if isinstance(b, str) else json.dumps(b))
                continue
            if r2.get('type') != 'assistant' or not isinstance(c2, list): continue
            for x in c2:
                if x.get('type') == 'tool_use':
                    inp = x.get('input', {}); calls[x['id']] = (inp.get('command') or inp.get('file_path') or '')[:90].replace('\n', ' ')
                    if up is None and f'seat {seat} --up' in json.dumps(inp): up = r2
            if up is not None and r2['message'].get('stop_reason') == 'end_turn': answer = r2; break
        if up is None: continue
        secs = lambda r3: int((when(r3) - when(r)).total_seconds())
        out.append((r['timestamp'][:16], seat, secs(up), tokens(up), secs(answer) if answer else -1, tokens(answer) if answer else 0,
                    sorted(reads.items(), key=lambda kv: -kv[1])[:5]))
for o in sorted(out):
    print(f"{o[0]} {o[1]:<15} seat-up {o[2]:>4}s {o[3]:>7,} tok | first answer {o[4]:>4}s {o[5]:>7,} tok")
    if top:
        for k, v in o[6]: print(f"      {v:>7,} chars  {k}")
```
