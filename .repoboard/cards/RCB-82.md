---
id: RCB-82
title: "Repo switcher cannot return to the primary: locationForRepo returns '' for the primary and location.assign('') resolves to the CURRENT url, ?repo= included, so fpj → repoboard reloads fpj; the store's unknown-key fallback (store.ts:248) has the same defect and would reload in a loop"
status: done
priority: high
labels:
  - web
files:
  - packages/web/test/repo-switcher.test.tsx
created: 2026-09-21T17:13:06Z
updated: 2026-09-21T17:17:31Z
---

## Log
- 2026-09-21T17:13:42Z builder — moved todo → doing
- 2026-09-21T17:17:31Z builder — updated files
- 2026-09-21T17:17:31Z builder — moved doing → done
