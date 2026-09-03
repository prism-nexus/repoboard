# Brief: P3 Web — the board (`packages/web`)

You are implementing P3.1–P3.5 of `docs/BUILD-PLAN.md` in `packages/web`. Do NOT commit. Do NOT
edit `packages/core` or `packages/server`. Read `CLAUDE.md`, the plan (§1 D5–D9, §2, §3, §5 P3),
and `packages/core/src/types.ts`. Import types from `@rcb/core` (it is I/O-free and browser-safe);
you may also import `avatarFor` and `isActive` from it.

The server may not exist yet while you work. **Build against the wire contract in plan §3**, and
ship a `src/mock/` module that serves a fake board + emits fake WS events on a timer so `pnpm dev`
in `packages/web` runs standalone with `VITE_MOCK=1`. That mock is also what tests use.

## Design direction — read before writing a component
Utility first, fun second, readability wins every tie. Think "a good terminal UI grew a body":
dense, high-contrast, monospace for ids and paths, a real typeface for titles. No template look.
Dark and light themes via CSS variables; respect `prefers-color-scheme`; a toggle. Column
headers show `count / wip` and go amber when WIP is breached. Cards: title, `RCB-n` in mono, a
priority stripe on the left edge (high = coral, medium = amber, low = slate), label chips, file
count, assignee avatar (emoji in a colored circle from `avatarFor`). Active cards (per
`isActive`) get a soft pulsing ring in the avatar color — that is the "someone is working here"
signal and it must be legible at a glance from across the room.

Fun layer (D9), all behind a single `fun` flag from config with a UI toggle persisted in
localStorage: card slide animation on column change (CSS transform, 250 ms), avatar bounce
when a card arrives in an active column, confetti (tiny, self-written, no library — ~60 canvas
particles for 1.2 s) when a card lands in a `done` column, and the activity ticker across the
top scrolling the last ~10 events as "🦊 web-agent moved RCB-12 → doing · 2m ago". With `fun`
off: no animation, no confetti, ticker becomes a static single line.

## Tasks
- **P3.1** Vite + React 18 + TS. `src/ws.ts`: connect to `/ws` (or mock), exponential reconnect
  capped at 10 s, a tiny store (zustand or a `useSyncExternalStore` hand-roll — no redux)
  holding `config, cards, repo, events, connected`. Columns from config in order. Cards sorted
  by `updated` desc within a column. A "disconnected" banner when the socket is down.
- **P3.2** Drag and drop with `@dnd-kit/core` + `@dnd-kit/sortable`. On drop send
  `{type:'card:move', id, status}`; move the card locally, but if no `card` echo arrives within
  3 s, snap it back and show a toast. Keyboard-accessible (dnd-kit's keyboard sensor).
- **P3.3** Card drawer (slide-in from the right, ESC closes): rendered markdown body (use
  `marked` or `markdown-it`; sanitize with DOMPurify), the `## Log` section shown as a timeline,
  editable title/assignee/status (select), sends `card:update`/`card:move`. Show `files` as a
  mono list.
- **P3.4** Ticker + avatars + fun layer as above. A top bar: repo name/branch from `repo.head`,
  connection dot, fun toggle, theme toggle, a "Board | Map" tab switch (Map is an empty panel
  with the text "P4" for now — leave a clean mount point `src/views/Map.tsx`).
- **P3.5** vitest + @testing-library/react + jsdom `web` project: (1) renders one column per
  config column with the right titles; (2) dispatching a `card` message with a new status moves
  the card element to that column; (3) a `card:move` is sent on drop (unit-test the handler,
  not real DnD); (4) bundle control: a test that runs after `vite build` (or a script
  `pnpm --filter @rcb/web check:size`) that fails if total gzipped JS in `dist/assets` exceeds
  600 KB. Wire that script into root `pnpm test` if it can run without a network. **Verify the
  size control by temporarily lowering the limit to 1 KB, running it, confirming it FAILS, and
  restoring — paste that evidence.**

## Build output
`vite build` → `packages/web/dist`. The server serves it from there in dev. Leave the copy-into-
server step to P6.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0 at root; `pnpm --filter @rcb/web build` succeeds;
report gzipped bundle size in KB. Take a screenshot of the board running against the mock
(`pnpm --filter @rcb/web dev` with `VITE_MOCK=1`, use the Chrome tools or `npx playwright
screenshot` if available; if neither works, say so and describe what renders). Report: file list,
command outputs, the bundle size, the size-control evidence, and what you decided where the
brief was silent.
