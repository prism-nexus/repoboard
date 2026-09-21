---
id: RCB-69
title: "Decision column hygiene (owner 2026-09-19 19:4xZ): a card in a `decision: true` column with NO open ask is a `repoboard check` finding (needs-ask), and `card move <id> <decide-column>` warns when the card has no open ask — every decision card must carry a place to start the discussion (an ask with letters, or a --task). Also: `card move` back INTO a decision column must not silently re-open a card already decided (FPJ-28 was decided A on the web 19:09Z and a bulk move returned it to the column 19:31Z) — refuse or require --reask. Owner's words: 'any ticket without an option needs to have a place to kick off the discussion to it is tracked on the card'."
status: done
priority: high
created: 2026-09-19T20:10:14Z
updated: 2026-09-19T21:03:12Z
---

## Log
- 2026-09-19T20:31:53Z builder — moved todo → doing
- 2026-09-19T21:03:12Z coordinator — moved doing → done
