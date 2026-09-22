---
id: RCB-80
title: "Systems flow view: a diagram of every layer of the served repo (systems used, connections, flow) with a DEV view and a PRODUCTION overlay/switch; a note when a repo has only one of the two (repoboard: local-only by design, for speed and tokens)"
status: doing
assignee: repoboard builder
priority: medium
size: XL
labels:
  - web
refs:
  - docs/SYSTEMS-FLOW-PLAN.md
  - docs/SYSTEMS-FLOW-PLAN.md#§4 The plan as cards — and the experiment on the plan itself
decision:
  question: "RCB-80 plan (docs/SYSTEMS-FLOW-PLAN.md §7): Q1 detection proposes + file is truth; Q2 own layout in core, inline SVG, no library; Q3 third top-level view 'flow'; Q4 repoboard first (none-prod case) then freshpickedjobs read-only; Q5 4,096 B budget; Q6 run the PH.7 board experiment before PH.1. Steps PH.0–PH.7 are on the board under this card."
  options:
    - letter: A
      text: take every recommendation as written
    - letter: B
      text: take them with changes stated in --words
    - letter: C
      text: park the card; not now
  askedBy: repoboard builder
  askedAt: 2026-09-22T03:53:26Z
  returnTo: backlog
  chosen: A
  words: null
  decidedBy: web
  decidedAt: 2026-09-22T03:58:48Z
created: 2026-09-21T05:34:15Z
updated: 2026-09-22T04:00:27Z
---
Owner (2026-09-20 22:4x Pacific): a user looks at a repo and sees what systems it uses and how they connect; two views, dev vs planned hosted, switchable/overlaid; when a repo has no dev or no prod story the view says so and what is shown (e.g. repoboard is meant to run locally for the most benefit of speed and token saving). Open questions for the owner before a brief: (1) source of truth — a hand-written `.repoboard/systems.yml` the agent maintains, auto-detection from the tree (package.json scripts, Dockerfile, wrangler.toml, .env.example, CI), or detection + hand overrides? (2) diagram engine — inline SVG laid out by us, or a Mermaid render? (3) where it lives — a fourth top-level view beside Board/Map, or a tab inside Map? (4) first target repo to design against: repoboard itself or freshpickedjobs (Cloudflare Workers + Neon)?

## Log
- 2026-09-22T03:53:26Z repoboard builder — updated refs
- 2026-09-22T03:53:26Z repoboard builder — moved backlog → decide
- 2026-09-22T03:53:26Z repoboard builder — asked: RCB-80 plan (docs/SYSTEMS-FLOW-PLAN.md §7): Q1 detection proposes + file is truth; Q2 own layout in core, inline SVG, no library; Q3 third top-level view 'flow'; Q4 repoboard first (none-prod case) then freshpickedjobs read-only; Q5 4,096 B budget; Q6 run the PH.7 board experiment before PH.1. Steps PH.0–PH.7 are on the board under this card. [A|B|C]
- 2026-09-22T03:58:48Z web — decided A
- 2026-09-22T03:58:48Z web — moved decide → backlog
- 2026-09-22T04:00:27Z repoboard builder — moved backlog → doing
- 2026-09-22T04:00:27Z repoboard builder — updated assignee
