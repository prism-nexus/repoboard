---
id: RCB-55
title: "Cold-start cleanup for the builder seat — proposal for the owner: retire stale docs/NEXT-AGENT-PROMPT.md + close HANDOFF §12 (A1), re-route CLAUDE.md to `seat <name>` (A2), STATE LIVE = slow facts only (A3), one docs/RIG.md for lock/ports/seat+session names (A4), SEATS bullets ≤3 lines (A5); product candidates B1 seat nextCard honours priority, B2 seat restamps its own SEATS bullet, B4 seat warns dist<src, B5 lock shim script, B6 RCB-54 follow-ups. Measured: cost 140,251 B ≈35k tok vs ~5k a builder needs; 4 questions to the coordinator, 3 answerable by A4. Decide which subset; each A item is one commit."
status: done
assignee: coordinator
priority: medium
labels:
  - dogfood
  - docs
files:
  - docs/COLD-START-CLEANUP-PROPOSAL.md
decision:
  question: "Your cold-start cleanup ask, drafted as docs/COLD-START-CLEANUP-PROPOSAL.md (measured: a builder loads ≈35k tokens and needs ≈5k; stale docs/NEXT-AGENT-PROMPT.md still routed from CLAUDE.md; two queues in STATE; `seat` ignores priority). Which subset?"
  options:
    - letter: A
      text: "A1–A5 now (docs/state only, one commit each: retire the stale prompt + close HANDOFF §12; re-route CLAUDE.md to `seat`; LIVE = slow facts only; a one-page RIG.md; SEATS bullets ≤3 lines) — and B1–B6 become todo cards for the builder after RCB-34"
    - letter: B
      text: A1–A5 now, B-items later — file no B cards yet
    - letter: C
      text: Read it first — hold everything
  askedBy: coordinator
  askedAt: 2026-09-18T22:15:21Z
  returnTo: todo
  chosen: A
  words: Rcb-55 a
  decidedBy: coordinator
  decidedAt: 2026-09-18T22:45:03Z
created: 2026-09-18T22:13:03Z
updated: 2026-09-18T22:54:51Z
---

## Log
- 2026-09-18T22:15:21Z coordinator — moved todo → decide
- 2026-09-18T22:15:21Z coordinator — asked: Your cold-start cleanup ask, drafted as docs/COLD-START-CLEANUP-PROPOSAL.md (measured: a builder loads ≈35k tokens and needs ≈5k; stale docs/NEXT-AGENT-PROMPT.md still routed from CLAUDE.md; two queues in STATE; `seat` ignores priority). Which subset? [A|B|C]
- 2026-09-18T22:45:03Z coordinator — decided A — "Rcb-55 a"
- 2026-09-18T22:45:03Z coordinator — moved decide → todo
- 2026-09-18T22:45:42Z coordinator — moved todo → doing
- 2026-09-18T22:45:43Z coordinator — updated assignee
- 2026-09-18T22:54:51Z coordinator — moved doing → done
