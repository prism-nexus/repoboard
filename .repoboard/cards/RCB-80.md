---
id: RCB-80
title: "Systems flow view: a diagram of every layer of the served repo (systems used, connections, flow) with a DEV view and a PRODUCTION overlay/switch; a note when a repo has only one of the two (repoboard: local-only by design, for speed and tokens)"
status: backlog
priority: medium
size: XL
labels:
  - web
created: 2026-09-21T05:34:15Z
updated: 2026-09-21T05:34:15Z
---
Owner (2026-09-20 22:4x Pacific): a user looks at a repo and sees what systems it uses and how they connect; two views, dev vs planned hosted, switchable/overlaid; when a repo has no dev or no prod story the view says so and what is shown (e.g. repoboard is meant to run locally for the most benefit of speed and token saving). Open questions for the owner before a brief: (1) source of truth — a hand-written `.repoboard/systems.yml` the agent maintains, auto-detection from the tree (package.json scripts, Dockerfile, wrangler.toml, .env.example, CI), or detection + hand overrides? (2) diagram engine — inline SVG laid out by us, or a Mermaid render? (3) where it lives — a fourth top-level view beside Board/Map, or a tab inside Map? (4) first target repo to design against: repoboard itself or freshpickedjobs (Cloudflare Workers + Neon)?