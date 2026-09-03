# Brief: P4 Web — the repo map (`packages/web`, plus one server task)

You are implementing P4.1–P4.4 of `docs/BUILD-PLAN.md`. Read `CLAUDE.md`, plan §1 D7, §4, §5 P4,
then `packages/web/src` (the board is built; `src/views/Map.tsx` is your mount point and the store
already holds `repo: RepoSnapshot`), and `packages/server/src/scanner.ts`. Do NOT commit.

Readability wins every tie. The map must answer three questions in under five seconds from
across the room: *what is this repo made of*, *where is the churn*, *who is working where*.

## P4.1 Treemap
`src/views/Treemap.tsx` with `d3-hierarchy` only (no full d3 bundle — import the sub-packages).
Build the hierarchy from `repo.files` paths; area = bytes; color = language (a fixed palette of
~12 languages + `other`, with a legend; the same language is always the same color). Directory
labels on tiles wide enough to fit; file labels on hover in a tooltip (path in mono, bytes,
lines, commits30d, lastCommitAt relative). Click a directory to zoom into it with a breadcrumb
to zoom out. Render as SVG; if the repo has more than 3,000 files, aggregate leaves below 0.1%
of the root area into an "…" tile per directory so the DOM stays under ~4,000 nodes. Measure
and report render time for this repo and for one big node_modules-free repo you find on disk.

## P4.2 Activity heat
A toggle "Size | Churn 30d | Churn 90d". In churn modes, tile fill opacity scales with commits
(sqrt scale, 0.15 floor so nothing vanishes), language hue retained. Also a "Recent" mode:
tiles colored by `lastCommitAt` age (today, week, month, older, never) on a single hue ramp.

## P4.3 Who is where — the point of the whole product
For every card where `isActive(card, config, now)` and `files` is non-empty: outline those
tiles in `avatarFor(card.assignee).color` (2 px stroke, plus a soft glow when `fun` is on) and
draw the avatar emoji in the tile's corner. Hovering a card on the board (the board and map are
different tabs — add a small "pinned card" affordance: clicking a card's avatar pins it, and
pinned cards' files stay highlighted on the map) highlights its files. Clicking a file tile
opens a side panel listing every card that names that path, active or not. A file named by a
card that no longer exists in the repo shows as a dashed "ghost" tile in the card's color at
the end of its directory — do not silently drop it.

## P4.4 Import graph (server + web)
Server (`packages/server/src/scanner.ts`, this is the ONE server file you may edit): for
`.ts .tsx .js .jsx .mjs .cjs` files, regex-scan `import … from '…'`, `export … from '…'`,
`import('…')`, `require('…')`; resolve relative specifiers to repo paths (try the given path,
then `.ts .tsx .js .jsx /index.*`); ignore bare packages. Fill `edges`. Cap at 5,000 edges.
Add a scanner test with a temp repo of three files that import each other.
Web: `src/views/Graph.tsx` with `d3-force`. Nodes = files with ≥1 edge; size by in-degree;
color by top-level directory; edges as thin lines. If nodes > 500, show a directory picker and
render only the chosen subtree. Same "who is where" outline treatment as P4.3. Drag to move,
scroll to zoom, click to open the file panel from P4.3.

## Tests
Add to the `web` project: treemap renders one tile per file for a 5-file snapshot; churn mode
changes opacity; an active card's file tile carries a `data-active-by` attribute with the
assignee. The bundle-size control from P3.5 still applies — d3 sub-packages must keep you
under it; report the new gzipped size.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0 at root; `pnpm --filter @rcb/web build`
succeeds; a screenshot of the map on this repo against the real server (`pnpm dev` from root
serves it on 4242 — check nobody else holds it first with `lsof -i :4242`) with at least one
active card highlighting files. Report: file list, outputs, render timings, bundle size,
decisions.
