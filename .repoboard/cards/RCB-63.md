---
id: RCB-63
title: "One process for both boards? RCB-43 landed (820b52f, 4f75bec, a263ec9): a single serve with --root . --root <fpj> can serve :4242's repoboard and :4243's fpj from one process and one port, switcher in the top bar — OWNER LETTER, not taken by a seat"
status: todo
decision:
  question: Consolidate the two boards into one serve process (one port, ?repo= switcher) or keep :4242 and :4243 separate?
  options:
    - letter: A
      text: "Consolidate now: one serve on :4242 with both roots; :4243 retired; the two top-bar cross-links become the switcher (Recommended)"
    - letter: B
      text: Keep two processes as they are; revisit after RCB-57..62
    - letter: C
      text: Consolidate on a third port first, dogfood a day, then retire the pair
  askedBy: coordinator
  askedAt: 2026-09-19T01:28:17Z
  returnTo: backlog
  chosen: A
  words: null
  decidedBy: web
  decidedAt: 2026-09-19T01:28:42Z
created: 2026-09-19T01:27:59Z
updated: 2026-09-19T01:33:31Z
---

## Log
- 2026-09-19T01:28:17Z coordinator — moved backlog → decide
- 2026-09-19T01:28:17Z coordinator — asked: Consolidate the two boards into one serve process (one port, ?repo= switcher) or keep :4242 and :4243 separate? [A|B|C]
- 2026-09-19T01:28:42Z web — decided A
- 2026-09-19T01:28:42Z web — moved decide → backlog
- 2026-09-19T01:33:31Z hometown — moved backlog → todo
