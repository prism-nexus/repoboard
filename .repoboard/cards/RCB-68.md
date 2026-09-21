---
id: RCB-68
title: "PHASES + GATES on the board (owner 2026-09-19 19:4xZ): a multi-part plan is a first-class board object — a phase card in TODO that owns child step cards, each step marked by its phase (PH.1 … PH.9) and by its GATE (an owner setup step, an account, a prior step, a word), shown as blocked-with-reason until the gate clears; the phase card rolls up its steps' state. First case: fpj Phase H live hosting (README K136 + parts K22 K23 K24 K25 K26 K138, plan docs/BUILD-PLAN.md §5.5): steps PH.0 (owner creates Cloudflare Workers Paid + Neon — the blocker) → PH.1 … PH.9, each gated. Design question for the builder: cards with a `phase:` and `gate:` field + a parent id, or a new card kind — propose in the card, build after the owner picks. Owner's words: 'Repoboard should also be handling phases which are not yet cards or maybe they are. We have the entire hosted portion of our plan we need to determine how that is represented and organized on the board, it is a plan that should be in to do and marked by its phase and the blocker of the user setting up the hosting. This is a great example of a multi part piece of work that has various gates to be completed'."
status: done
priority: high
decision:
  question: "Builder's proposal for phases + gates (RCB-68). Shape: THREE optional card fields, no new card kind — (1) parent: <card id> makes a card a STEP of that phase card; (2) phase: PH.<n> (free short label, sorted naturally) marks the step; (3) gate: <card id> | \"<sentence>\" is what blocks it — a card id clears itself when that card reaches a done column or is decided (an owner --task counts), a sentence is cleared by hand (card update --clear gate --as owner, logged). Blocked = gate present and not clear; card list / list_cards get a blocked column with the reason; check gets an info finding gated-steps (count). The phase card is any card that has children: its chip reads n/m done and it rolls up 'blocked on <gate>' from its first blocked step; children show a PH.n chip and a blocked-with-reason chip. Both boards get it via the same board.yml columns, no schema change, sync-issues untouched. First case: fpj Phase H = one phase card in todo (README K136), steps PH.0 'owner creates Cloudflare Workers Paid + Neon' (an owner --task, THE gate) and PH.1..PH.9 with gate: <PH.0's id> or the prior step's id. Web grouping by phase (swimlanes) is a follow-up card, not this one."
  options:
    - letter: A
      text: "fields as proposed: parent + phase + gate on ordinary cards, rollup on the parent card, blocked chips; swimlanes later (recommended)"
    - letter: B
      text: a new card kind phase whose body holds a steps list; steps become cards only when started (cheaper file churn, but steps are invisible to card list, leases and check until then)
    - letter: C
      text: A plus the web swimlane grouping in the same card (bigger, one landing)
  askedBy: builder
  askedAt: 2026-09-19T20:34:50Z
  returnTo: todo
  chosen: C
  words: "C (owner 2026-09-20 01:5xZ, to the builder seat in chat: 'C')"
  decidedBy: owner
  decidedAt: 2026-09-20T02:36:09Z
created: 2026-09-19T19:18:50Z
updated: 2026-09-21T17:54:14Z
---
## Notes
- 2026-09-21T17:54:14Z coordinator — Coordinator post-landing check 2026-09-21 10:5x Pacific: VERIFIED by content on origin/main + a scratch board (positive scenario + negative control each; report in the fpj coordinator log 17:5xZ).

## Log
- 2026-09-19T20:34:50Z builder — moved todo → decide
- 2026-09-19T20:34:50Z builder — asked: Builder's proposal for phases + gates (RCB-68). Shape: THREE optional card fields, no new card kind — (1) parent: <card id> makes a card a STEP of that phase card; (2) phase: PH.<n> (free short label, sorted naturally) marks the step; (3) gate: <card id> | "<sentence>" is what blocks it — a card id clears itself when that card reaches a done column or is decided (an owner --task counts), a sentence is cleared by hand (card update --clear gate --as owner, logged). Blocked = gate present and not clear; card list / list_cards get a blocked column with the reason; check gets an info finding gated-steps (count). The phase card is any card that has children: its chip reads n/m done and it rolls up 'blocked on <gate>' from its first blocked step; children show a PH.n chip and a blocked-with-reason chip. Both boards get it via the same board.yml columns, no schema change, sync-issues untouched. First case: fpj Phase H = one phase card in todo (README K136), steps PH.0 'owner creates Cloudflare Workers Paid + Neon' (an owner --task, THE gate) and PH.1..PH.9 with gate: <PH.0's id> or the prior step's id. Web grouping by phase (swimlanes) is a follow-up card, not this one. [A|B|C]
- 2026-09-20T02:36:09Z owner — decided C — "C (owner 2026-09-20 01:5xZ, to the builder seat in chat: 'C')"
- 2026-09-20T02:36:09Z owner — moved decide → todo
- 2026-09-20T02:36:16Z builder — moved todo → doing
- 2026-09-21T17:54:14Z coordinator — moved doing → done
