# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **A member board reads its home board's seats, read-only (RCB-184).** A new optional
  `board.yml` key, `workspace: <home root>`, names the board a shared seat lives on (a workspace's
  coordinator). `seat list` then shows the home's own seats after this board's, named
  `[<home>] <seat>` and read live from the home's STATE.md and `seats.yml`; nothing is written there.
  A bullet in this board's own SEATS prefixed with the home's name is a stale copy: `seat list`
  leaves it out and `check` warns `seat-copy`. `check` also warns `seat-home-unreadable` and
  `seat-home-not-member` (the home's `repos:` does not list this repo), and `stale-state` no longer
  goes red over a block the home's seat wrote in this board's log. Without the key nothing changes.
  The Board's Seats panel and status line show the home's seats too, after this board's own and
  marked "home · read-only", with no working-on cards, seat events or takeover hint (those live on
  the home board); the home is re-read on every seats send, so a change there arrives within the
  30 s poll. Each seat on the wire carries `home`: the home's name, or `null` for an own seat.
- **Seat rows, landings and seat events on the wire (RCB-217).** The WebSocket snapshot gains
  `seats` (each seat's status, stamp, holder pane, holder liveness, in-flight and owes, from the
  same parser `seat list` uses) and `landings` (commits whose subject starts with a card id, read
  from the last 14 days of git, grouped by card). A seat write that changes a status appends a
  `seat` event. `{type:"seats"}` is sent after every STATE.md change and seat event, and a 30 s
  poll re-sends seats and landings only when they changed, and only while a client is connected.
  The snapshot's log is today's when it has a block, else the newest earlier day within 14 days.

### Changed

- **The top of the Board is a status line and three panels (RCB-216, RCB-218).** The Board
  view's status line has one pill per seat (● UP, ○ DOWN, ⚠ UP with a dead holder, ? liveness
  unknown), an Owner queue count that opens the first queued card, one pill per held lease, and
  the newest event. Below it: Seats (per seat: since when, the Doing cards assigned to it, in
  flight, owes, its last two seat events, and how to take over a seat whose holder is dead;
  Doing cards no UP seat holds are listed as unclaimed), Landed (from git, with a warning when a
  landed card is not in a done column) and Owner queue (a click opens the card). The LIVE and
  LAST LANDINGS rows are gone from the Board; they stay in STATE.md. The LOG row names the day
  when it is not today. The other views keep the Now strip and the Ticker.
- **`scripts/publish.sh` moves chosen card commits to `main` by pull request (RCB-222).** Work
  lands on a development branch first. `scripts/publish.sh <card-id|sha>...` picks the chosen
  commits that are not yet on `main` onto a temporary copy of it, runs the public check (the
  private denylist over the tree, the commit messages and the added lines) and lists what would go
  out, pushing nothing. `--apply` pushes a `publish/<ids>` branch and opens the pull request,
  which merges after green CI; with no denylist it refuses.

- **Releases publish from CI with npm trusted publishing and provenance (RCB-214).** Pushing a
  `v*` tag runs `.github/workflows/release.yml`: it fails unless the tag is `v` plus the
  `packages/server` version and that version is not on npm, runs test, typecheck, lint and build,
  packs once, smoke-tests that tarball, and publishes that same tarball over OIDC — no npm token
  is stored anywhere. A manual run does all of it except the publish and ends in
  `npm publish --dry-run`, which it skips, with a notice, when the version is already on npm (npm
  refuses a dry run of a published version). The route needs the owner to register the workflow as
  the package's trusted publisher on npmjs.com first; the workflow's header comment lists the steps.

### Fixed

- **Text that starts with "- " is text, not an option (RCB-220).** `log --as s "- a bullet"`,
  `card add "- x"`, `card note <id> "- x"` and an option value such as `--title "- x"` used to
  exit 1 with `Unknown option '- '` or `argument is ambiguous`, and wrote nothing. The one shared
  argument parser now reads an argument that starts with a dash and then whitespace as text, so a
  Markdown bullet works in each of the 12 commands that take free text. Every other argument parses
  as before: `-5 degrees` or `--title -x` still exit 1, and still need `--` before the text or the
  `--title=-x` form.

## [0.3.1] — 2026-10-01

### Added

- **`check` reads a private denylist (RCB-209).** `.repoboard/local/public-denylist.txt` holds one
  extended regex per line, matched case-insensitively; `#` lines are ignored.
  `public-denylist-hit` (error) reports each tracked line that matches as `path:line` only, never
  the matched text; lockfiles and binaries are skipped. `public-denylist-invalid` (error): the
  file is unreadable, or git cannot compile a pattern. `public-denylist-missing` (info): a local
  layer that is its own git repo has no such file. With no local layer, `check` says nothing.

### Changed

- **`engines.node` is `>=20.19.0`, was `>=20` (RCB-209).** chokidar 5 and readdirp 5 need it; CI's
  pack-smoke installs the packed tarball on Node 20, 22 and 24.
- **The GitHub repository starts a fresh history at 0.3.1 (RCB-209).** It was recreated under the
  same name with one first commit, and `v0.3.1` is its first tag. Links to earlier commits, pull
  requests and Actions runs no longer resolve; this file is the record of 0.1.0 to 0.3.0.
- **The README screenshots show a demo project (RCB-209).** `docs/board.png` and `docs/map.png`
  were taken of this repo's own board at 0.1.0. They are retaken from a fresh `init` demo board
  (13 cards, 7 systems), and `docs/flow.png` adds the Flow view. `docs/drawer-refs.png`, which no
  file referenced, is removed.

### Fixed

- **Ranged pointers read "not found" in a system's tests and coverage (RCB-208).** A `systems.yml`
  pointer written as `path:L10-L20` (what `systems detect` records since RCB-177), `path@Token`
  or `path#Heading` was looked up verbatim as a file path, so `systems show`'s `tests:` line read
  `n/a (no source pointers)` and `lines:` read `n/a (not found)` — 9 of 9 ranged pointers on this
  repo's own board. The coverage staleness check had the same blind spot and could call a report
  fresh over a changed file. All three lookups now go through core `refPath` (the same `parseRef`
  the pointer display uses) and answer for the pointer's whole file; a spec that does not parse
  reads `invalid pointer`.
- **`serve --port N` exits when N is taken (RCB-209).** With N already in use, `repoboard serve
  --port N` printed "port N is already in use" and then never exited: the repo watcher, WebSocket
  server and timers opened before the bind failed were never closed. They are now closed; the
  message is unchanged.
- **`check --help` and the findings table name every finding kind (RCB-209).** `repoboard check
  --help` named 21 of the 28 finding kinds and `docs/REFERENCE.md`'s findings table 17; both now
  name all 28, and a test holds them and the README's check list to the code's one list
  (`FINDING_KINDS`, exported from the core package).

### Security

- **Dependencies past four advisories (RCB-209).** dompurify 3.4.14 -> 3.4.16 in the web app,
  whose floor is now `^3.4.16` (GHSA-p98j-92pf-mc4p, low). hono 4.13.5 -> 4.13.12
  (GHSA-hxh3-vqpv-xpqv, moderate) and ip-address 10.7.0 -> 10.7.2 (GHSA-h3mg-xc3c-68pw and
  GHSA-j6r3-76f7-8jcv, moderate) come in through the MCP SDK; both versions sit inside its
  existing ranges, so only the lockfile moved.

## [0.3.0] — 2026-09-30

### Highlights

What changed since 0.2.0, card ids in parentheses are the project's own card ids:

- **Workspace gate visibility, all four surfaces (RCB-154).** A workspace card gated on a member
  card now reads clear (or blocked) correctly in `seat`, `state`'s gated-steps count, MCP
  `list_cards`' `blocked` field, and the web board — previously all four erred to blocked, or
  printed "(no such card)", for a member gate.
- **Every seat names its repo (RCB-160).** SEATS bullets, log block headers, `seat <name>`'s
  bundle header, and — new at a workspace root — the `state` SEATS section now carry the board's
  `board.yml` `name` (e.g. `[repoboard] builder: UP …`), automatic and never typed; `check` warns
  when a workspace member's `repos[].key` differs from that member's own `board.yml` `name`.
- **Systems: what unblocks a planned or blocked piece (RCB-161).** `systems.yml` rows and
  connections gain `status: live | planned | blocked` (absent → `live`) and `unblocked_by: [<card
  id>…]` (absent → `[]`); `repoboard systems` adds a `STATUS` column once any row is non-`live`;
  `repoboard systems show <id>` resolves each unblocker inline — the card's title/status plus its
  open decision or next unblocked step; the Flow view draws a planned/blocked box or edge dashed
  with a status badge and the drawer gets an "Unblocked by" section; `check` gains
  `systems-unblocker-unknown` (warning, a dangling id) and `systems-planned-without-unblocker`
  (warning); `systems detect` proposes a no-signal package matching a known integration name (or
  living under `integrations/`) as `external`/`planned` instead of dropping it unclassified.
- **Systems: a rejection sticks (RCB-162).** `systems.yml` gains a `rejected:` list (a system id,
  or a connection's `from`/`to`, each with a required `why`) — `systems detect --apply` never
  re-proposes a row the repo already turned down.
- **`repoboard systems` stays display-only (RCB-163).** A dangling `unblocked_by` id now prints a
  `warning: <message>` line on stderr (`--json`: `warnings: string[]`, always present), but the
  exit code is unchanged — `check` alone exits non-zero for a systems finding.
- **Watcher reliability (RCB-157, RCB-164).** A periodic reconcile sweep (`reconcileMs`, default
  `2000`ms while watching, `0` when not, `<= 0` off) re-stats tracked files and routes anything the
  watcher itself never reported — the fix for a measured miss (65/1080 macOS trials, 0/1080 on
  Linux, no raw watcher event at any delay) that could leave a board silently stale until restart.
  An opt-in diagnostic recorder (`REPOBOARD_WATCH_DIAG=1`, set in CI) traces the watcher's
  lifecycle per store root so the next miss carries a log instead of a bare timeout. A same-change
  seen via two sources (the watcher and the sweep) is now deduped so it is never routed twice.
  Separately, a slow in-place write (a gap between `open(O_TRUNC)` and the actual write) no longer
  makes the store read a card as removed: `emptyGraceMs` (default `1000`ms, `<= 0` off) holds a
  0-byte read of a known card file before re-checking it.
- **Systems: connections carry a label, pointers and an id; unknown keys are warned (RCB-173).**
  A `connections:` row gains optional `label` (a 1–40 character caption), `pointers` (the same
  refs grammar a system row has, resolved at `GET /api/systems/connections/:from/:to/refs`, with
  `?id=` for a shared pair) and `id` (the only way two rows may share a from→to pair). A key no
  schema knows — a typo, or a field from a newer repoboard — is now a `systems-unknown-key`
  warning on `repoboard systems` (path + key, exit 0) where it used to vanish silently;
  `systems detect --apply` still drops it when it rewrites the file, and the warning says so. A
  re-detect keeps a detected row's hand-added label/pointers/id. The
  byte budget is raised from 4,096 B to 16,384 B (owner, 2026-09-29) and now actually checked:
  `systems-over-budget` is a warning, never enforced.
- **Flow view: pan, zoom and find (RCB-174).** The diagram opens fitted to the canvas instead of
  being shrunk to the page width (a large member map rendered at about 0.53×, 12 px text at
  about 6 px); wheel and pinch zoom about the cursor (0.25×–3×), drag pans, Fit / 100% / − / +
  buttons and `f` / `0` / Esc keys. Clicking a box focuses it — everything but the box and its
  direct neighbours dims — and the open drawer keeps its width clear and pans a hidden selected
  box into view. A filter (id, name or kind) dims the boxes that do not match.
- **Flow view: kinds, arrows and legible boxes (RCB-175).** Every edge ends in an arrowhead
  (solid when live, open when one-env or planned, coral when blocked), and a connection that runs
  both ways draws as two lines 8 px apart instead of one. Every box shows its kind as a glyph (a
  cylinder for db/storage, bars for a queue, a cloud for external, …) and a kind name coloured by
  family (data stores / compute / external / ops, both themes); a Legend toggle lists only the
  kinds on this map. An id or name wider than the 170 px box ends in `…`, full text on hover;
  rows sit on alternating bands; the environments' note is one muted line under the
  dev/prod/both switch.
- **`systems detect` evidence points at lines (RCB-177).** A detected row's `source.detected` and
  `pointers` (and a detected connection's `pointers`) are now `<file>:L<a>-L<b>` — the binding's
  record in wrangler JSON/JSONC, the `binding =` line under its TOML table, a compose service's
  block, a `KEY=` line — instead of `<file>@<key>`, which never resolved as a ref (0 of 22 on
  a member repo). A value that cannot be located keeps `<file>@<key>` and the whole-file
  pointer, never a guessed line. On a detected connection, `--apply` swaps any `path:L…` range
  into a file it just located the value in for the fresh range — a hand-added range into that
  same file too, since the two cannot be told apart — and keeps every other pointer. A
  `path@Token` ref also finds a quoted key (`wrangler.jsonc@triggers` → `"triggers": {`), tried
  only when no line starts with the token bare.
- **`path@a.b` refs read as a key path (RCB-187).** A dotted token that no line starts with
  literally now resolves `a`'s span first, then the first `b` inside it (`@a.b.c` nests further),
  and answers `b`'s span clamped to `a`'s end — `wrangler.jsonc@durable_objects.bindings` and
  `wrangler.jsonc@triggers.crons`, 3 member-repo `systems.yml` pointers that read "no line
  starting with …", now resolve (L127-137 and L480-489 on that file). A literal match still wins
  (`@P6.1` is not split); a missing segment is named with its parent (`@triggers.bindings`
  → `no "bindings" under "triggers"`); an empty segment (`@a..b`) is an error.
- **Flow view: click a connection (RCB-176).** Each edge has a 14 px transparent hit path over its
  route: hover lights the line, click opens a connection drawer with the row's `label`, `via`,
  `env`, `status`, `unblocked_by` (card buttons), `source`, and its `pointers` resolved live from
  `/api/systems/connections/:from/:to/refs`; its two ends are buttons that open those systems.
  A connection's `label` is drawn at the route's midpoint (cut at 160 px, full text on hover);
  `via` is never drawn on the line. The system drawer's connection list links both ways. Parallel
  rows of one pair are drawn side by side instead of on top of each other. The selection is in
  the URL (`?view=flow&system=<id>` or `&conn=<from>,<to>[,<id>]`, written with `replaceState`),
  so a link opens that drawer; an unknown or ambiguous id opens nothing.
- **Flow drawers: how to get there (RCB-178).** Each resolved pointer in the system and connection
  drawers gets an `editor` link (`vscode://file/<root>/<path>:<start>`) and a `GitHub` link
  (`<origin>/blob/<HEAD>/<path>#L<start>-L<end>`), built from a new `GET /api/git` (`{root, web,
  head}`, read live on every drawer open — a stale sha beside live line numbers would be a wrong
  link). No GitHub link when `origin` is not GitHub, there is no commit, or the served root is a
  subdirectory of its repo; no link at all on a ref that did not resolve. A system's `docs[]`
  now resolve like pointers (`GET /api/systems/:id/docs`, same wire and 404 as `/refs`) instead of
  printing as bare strings. `runtime dev`/`runtime prod` get a copy button; a refused or missing
  clipboard says `copy failed`.
- **Flow view: edges no longer share points or lines (RCB-179).** Every edge meets a box side at
  its own port (the k-th of n spread along the side, ordered by the far end's x), each horizontal
  run gets its own track in the row gap and each long vertical run its own lane in a column gap or
  right of the last column, and no route passes through a box that is not one of its ends. On the
  three real maps: acme 19 edges went from 16 overlapping, up to 10 per exit point and 2
  under a box to 0, 1 and 0; repoboard 3/2/2 → 0/1/0; globex 2/2/1 → 0/1/0. Two-way pairs and parallel
  rows are separate routes in core, so the web no longer shifts them (`PAIR_OFFSET`/`ROW_GAP` gone).
- **Flow view: walk-throughs and a summary strip (RCB-180).** `systems.yml` gains an optional
  `paths:` list: named routes (`{ name, hops, source }`, e.g. `web → api → db`), each consecutive
  hop required to be a connection in that direction (an error names the pair, and the reverse
  when only that exists); an unknown key in an entry is a `systems-unknown-key` warning. The Flow
  toolbar's `Paths` select walks one hop at a time: Prev / Next, that hop's edge(s) and two boxes
  lit, the rest dimmed, each step panned into view; Esc or `none` ends it, and a path not drawn
  in the env on show is listed disabled. A strip under the toolbar lists the data stores,
  externals and entry points the env draws (core `flowOverview`), each id selecting its box.
- **Flow view: a crowded row gap grows (RCB-192).** A row gap is `0.125 * (tracks + 1)` units tall
  when its tracks need more than the usual 1 unit, so tracks, and every stub and jog, are at
  least 8 px apart (the arrowhead's length); the rows below move down and the row bands still
  tile. acme's hub gap (17 tracks) went from 64 to 144 px and its shortest vertical
  segment from 3.6 to 8 px; repoboard and globex (at most 3 tracks) lay out byte-identically.
- **Seat identity: a seat is held by a pane (RCB-194, steps RCB-195..RCB-200).** A pane could
  write another pane's seat; a seat now has a recorded holder. `seat <name> --up` writes the
  holder (terminal pane, host, pid and the process's start time) to the gitignored
  `.repoboard/local/seats.yml`, which is also kept out of the local layer's own git and never
  leaves the machine, and labels the SEATS bullet `· <tag> · <short> <seat>` (`· 1D3F · rcb
  builder`: a 4-character pane tag, 6 when another holder shares it); `--down` drops the record
  (RCB-195). Hardening: a stamped bullet is found only by its exact seat name (`builder` no longer
  owns `builder-2` or `web builder`), `state --set-section SEATS` needs `--force`, seat writes and
  log appends are refused from a linked git worktree, and a log append is read-modify-write under
  a file lock so two writers each land their block (RCB-196). `--up` is a claim decided inside the
  `seats.yml` and STATE.md locks, on fresh reads: the same pane re-ups without `--force` (a new
  session after `/clear`), a holder whose process is gone is taken over with an audit block in the
  log, another live pane's seat is refused naming both labels (`--force` takes it, audited), and a
  pane already holding another UP seat is refused unless `--from <seat>` moves it, writing that
  seat DOWN in the same write (RCB-197). `--down`, `--update`, `log --as`, MCP `append_repo_log`
  and `POST /api/log` (409) are refused, exit 1 with nothing written, from a pane that is not the
  holder; `--force` writes anyway after one audit block, and a seat with no recorded holder stays
  writable by anyone (RCB-198). `seat whoami [--json]` prints which seat this pane holds (`1D3F ·
  rcb builder`, or `1D3F · no seat`, exit 0 either way) and writes nothing; `seat list` gains PANE,
  LABEL and LIVE columns and a `!` line for each seat whose recorded holder's process is dead; MCP
  `get_seat` and `seat <name> --json` carry a `holder` (tag, label, liveness) (RCB-199). `check`
  gains six seat findings: `seat-duplicate-bullet` and `pane-holds-two-seats` (errors), and
  `seat-name-ambiguous`, `seat-log-while-down`, `seat-up-dead-holder` and
  `seat-lease-bullet-drift` (warnings, blocking only with `--strict`); the three checks that read
  holders say nothing without a local layer or a readable `seats.yml` (RCB-200).

### Fixed

- **A seat with no bullet no longer takes over another seat's (RCB-168).** `seat <name>`'s
  fallback match (the name anywhere in a bullet's first line, kept for hand-written legacy
  bullets) now skips every stamped bullet, so a seat named only in another seat's prose appends
  its own bullet — on a workspace board, `seat builder --down` had replaced the coordinator's
  bullet, exit 0.
- **A git checkout no longer turns `check` red (RCB-170).** `stale-state` judges a log file by
  its `#####` headers alone; the file's mtime counts only when it has no parseable header. A
  checkout, merge or stash that rewrote an old day's log file set its mtime to "now", and `check`
  reported `stale-state` with no new log entry anywhere.
- **A worktree no longer grows a tracked STATE.md or log (RCB-171).** When the root `.gitignore`
  ignores `.repoboard/local/` and that directory is missing (a git worktree, a fresh clone),
  `log`, `seat` and `state --set-section` now refuse (exit 1, naming the missing layer) a write
  that would CREATE STATE.md or the log directory, instead of silently creating
  `.repoboard/STATE.md` and `.repoboard/log/` in tracked paths. An existing STATE.md or log
  directory, a board with no such ignore line, and a `board.yml` `logDir` are written as before.
  `seat --up --force` whose audit block cannot be written is refused rather than going through
  unaudited.
- **A second `--up` no longer takes over a seat that is still working (RCB-169).** `seat <name>
  --up`'s presence guard measured liveness from the bullet's UP stamp alone, but `--update` keeps
  that stamp on purpose — so a seat UP for a day that had updated its bullet or logged minutes ago
  was overwritten with no refusal (acme, 2026-09-29: ops' `in-flight:` line erased).
  The guard now takes the newest of the UP stamp, the seat's newest log block on this board, and
  STATE.md's stamp when this seat wrote it, and the refusal names which (`logged 10 min ago`,
  `STATE written 10 min ago by ops`). `--force` still takes over, audited.
- **One seat, one name (RCB-172).** `seat "repoboard builder"` and `seat "[repoboard] builder"`
  created a second and a third builder bullet (`[repoboard] repoboard builder`, `[repoboard]
  [repoboard] builder`). Every entry point that takes a seat name — CLI `seat`, `log --as`,
  `log --last`, `log show --seat`, `state --trim-landings --as`, MCP `append_repo_log`, `get_log`
  and `get_seat` — now strips a leading `[<board>]` or `<board> ` word (case-insensitive) and
  refuses another board's `[…]` prefix. Confirmations print the label the bullet carries
  (`restamped SEATS [repoboard] builder: UP …`), so the prefix is seen, not typed.
- **The web's log door folds a board prefix too (RCB-188).** `POST /api/log` handed the typed seat
  straight to the store, so `[repoboard] builder` from the web wrote a block headed `[repoboard]
  [REPOBOARD] BUILDER` where the CLI and MCP wrote `[repoboard] BUILDER`. The seat door now runs
  inside the store's `appendSeatLog`, `setSeatBullet` and `updateSeatBullet` themselves, first
  and on every call, so no entry point can skip it; another board's prefix is a 400 with nothing
  written.
- **Closing a store waits for its own writes (RCB-193).** `close()` resolved while a change the
  watcher or the sweep had routed was still between its `card` emit and its `events.jsonl`
  append: measured, the line had landed by close 0 times in 30 and 200 ms later 15 times in 15,
  and CI's test cleanup hit `ENOTEMPTY` on `.repoboard`. `close()` now drains the store's queue
  (and waits for a sweep in flight), and a claim or empty-read grace timer can no longer be armed
  once close has begun.
- **Seat identity follow-ups (RCB-206).** An unreadable `.repoboard/local/seats.yml` (a
  directory, no permission) no longer crashes `seat whoami` or `seat <name>` (exit 2): whoami
  exits 1 naming `cannot read: <code>`, the bundle carries it as `holderError`, and a seat write
  is refused with nothing written. Its parse errors now name `seats.yml`, not `leases.yml`, and
  say `nothing was written` only on a write. `seat <name> --up` finds the seat's lease in any case
  (`--up Builder` over `seat:builder`): the holding pane re-ups instead of being refused, another
  pane is refused by the holder rather than only inside the old 30-minute window, and the lease
  keeps its own spelling instead of gaining a second one. `state --set-section` (every section),
  `--trim-landings` and MCP `set_state_section` are refused from a linked git worktree, like the
  seat verbs and log appends. The local layer's git exclude gains `*.lock` and `*.tmp`, so a lock
  or tmp file held during a sync is never committed and pushed.
- **Seat refusals name the fix and the pane (RCB-207).** `seat <name> --up`, `--down` or
  `--update` followed by another `--flag` exits 1 with one line naming the order
  (`--up takes its text next: seat <name> --up "<text>" [--pane <tag>]`) instead of a parse
  error and the full usage; nothing is written. A `--pane` mismatch ends `; you are <label>`,
  like every other seat refusal. A forced SEATS rewrite (`state --set-section SEATS --force`,
  MCP or HTTP `force`) appends one audit block before it writes. The ambiguous-seat-name warning
  says which bullet a seat verb takes.

### Maintenance

- README's two "not on npm yet" sentences dropped, current since the 0.2.0 publish (RCB-155).
- Doc drift after 0.2.0: `SECURITY.md`'s supported line, `CONTRIBUTING.md`'s CI Node-version line,
  and the repo homepage brought back in sync (RCB-156).
- Outside PRs: delete-branch-on-merge on, squash-only (merge commits and rebase merge off)
  (RCB-158).
- `esbuild` pinned to `>=0.28.1` via a pnpm override, closing Dependabot alert 1 (dev-only, low)
  (RCB-159).
- `fast-uri` 3.1.6 → 3.1.8 in the lockfile, closing Dependabot alert 2 (high, dev-only: it
  reaches the tree only through the `@modelcontextprotocol/sdk` devDependency via `ajv`; the
  shipped `dist/cli.js` has 0 references to it) (RCB-185).
- `undici` 8.10.1 → 8.11.2 via a pnpm override (`^8.10.2`), closing Dependabot alerts 5-9, 12, 13
  (7 open: 2 high, 2 moderate, 3 low; dev-only: it reaches the tree only through `jsdom`, a
  test dependency; the shipped `dist/cli.js` has 0 references to it) (RCB-189).
- A store test that waited on the macOS file watcher to deliver two events (it timed out in 1 of
  4 local full runs) now drives the watcher's own handler, so it proves the same-source skip rule
  deterministically: 20/20 runs pass, and it still fails when that rule is removed (RCB-186).
- A systems test could lose the server's first WebSocket message: it attached its listener after
  `await`ing the open socket, and a frame that arrives in the same chunk as the upgrade is
  emitted before that `await` resumes (CI run 36627126875 timed out this way). The listener is
  now attached inside the `open` handler, as the other WebSocket tests already did (RCB-191).
- This repo's own `systems.yml` uses the new connection fields: each of its 3 connections has a
  `label` and line-range `pointers`, and its 9 system pointers are line ranges instead of whole
  files; two dogfood tests keep every connection pointer resolving untruncated and every
  connection labelled (RCB-181). The row for a second `--root` repo no longer claims the second `--root` is
  read-only: its board takes edits from the browser like the primary's (RCB-190).

## [0.2.0] — 2026-09-25

### Highlights

What changed since 0.1.0, card ids in parentheses are the project's own card ids:

- **Workspace: one board that coordinates several (RCB-153).** A `board.yml` with `repos:` (each
  `{key, root, writes?}`) makes a board a workspace over member boards. At its root: `state` and
  `check` aggregate every member (`[<key>]`-prefixed; a missing member is a
  `workspace-member-missing` finding, not a crash); card ids resolve by prefix across boards
  (`<key>:<id>` when two share one); `card list --repo <key>|all`, `card add --repo <key>`; a
  workspace card's `gate:` may name a member card; `serve` with no `--root` serves the workspace
  and every member under their configured keys (any `--root` turns that off); `init --workspace
  --repo <key>=<path>` scaffolds one; `mcp` gives the same verbs an optional `repo` argument
  (tool count unchanged, and a board without `repos:` sees a byte-identical `tools/list`).
  Members are read-only unless listed with `writes: cards`, and even then a write touches only
  that member's card file and its `events.jsonl`.
- **The systems map (Flow view).** The `systems.yml` model and layout (RCB-95); `systems detect
  [--root] [--apply] [--json]` — dry-run default, provenance stamped, hand rows win, and a
  `none` environment is now dropped from systems and connections instead of proposed (RCB-96;
  RCB-123 closes K15); `systems` / `systems show`, MCP `list_systems`/`get_system`, `GET
  /api/systems` (RCB-97); the Flow view — rows by layer, dev/prod/both, one-env dashes, a
  none-note, drawer readable at a glance with pointers collapsed by default and backlinks
  (RCB-98, RCB-109); "Plan the systems map" creates the detect → hand-correct → connect step
  cards when a repo has no `systems.yml` (RCB-111); which test files exercise a system, static
  and live (RCB-110); per-pointer test coverage read from the gate's coverage report (RCB-113);
  a Flow edge between two boxes two rows apart in one column no longer runs through the box
  between (RCB-124 closes K14).
- **The repo dashboard.** A "Repo" tab per served repo — health (last recorded gate per check),
  commits (HEAD + origin/main, 14-day cadence, per author), systems + coverage; `GET
  /api/dashboard`; `repoboard gate record|show`, where a same-second ledger tie now goes to the
  later line and `gate record --tests` without `--failed` is exit 1, nothing written (RCB-112,
  RCB-116).
- **Plan-ux gaps.** `card list --parent <id> [--unblocked]` and `card show --steps` in phase
  order (RCB-104); `card show --resolve` merges overlapping spans of one file instead of
  repeating them (RCB-106); `card ask`/`decide` write a `## Decision` body section that survives
  every re-ask (RCB-107); a gate on a DONE card is history and no longer blocks it (RCB-105);
  lane phase chain across columns, plan parents not counted against WIP by default (RCB-108);
  `seat <name>` Next card follows a parent's next unblocked step (RCB-103).
- **The practices layer, hardened.** `seat --up` refuses a second UP inside the active window,
  `--down` requires `in-flight:`/`owes:` lines, `--update` rewrites the bullet body, `seat list`
  (RCB-87, RCB-88, RCB-89); `repoboard log` refuses a missing seat and writes to `board.yml`'s
  `logDir` when set (RCB-71); `state --trim-landings <n>` archives older LAST LANDINGS entries
  verbatim (RCB-92); `cost` bills a FROZEN-linked file separately and leaves it out of the total
  (RCB-91); `check` reports a future-stamp and no longer flags a STATE stamp equal to the newest
  log header second (RCB-90; RCB-122 closes K13), and warns on card files git does not track,
  naming each id and its creator (RCB-119); local `init` keeps a tracked STATE.md/log in place
  (RCB-93); `seat` says why Next card is empty (RCB-118); `leases.yml` and `STATE.md` writes
  serialize under one cross-process lock, an O_EXCL steal once the holder is dead or the lock is
  older than 30 s (RCB-133); a log block from an UP seat restamps STATE.md, so `check` stays
  green mid-session (RCB-127); `local init --remote none` acks a local layer with no backup and
  `check`'s local-no-remote goes quiet (RCB-128); `repoboard decisions` / MCP `list_decisions` —
  answered, not acknowledged (RCB-129); `check` flags a hand-typed OWNER QUEUE that drifts from
  the generated one (RCB-130); live leases surfaced in `seat <name>`, `state` and `check`
  (RCB-131); `log show --since/--tail`, `state --trim-landings --archive <path>` (RCB-132);
  `seat` prints one line instead of six empty sections on a solo board (RCB-140); `--json` on
  `card show`, `log show` and `state` (RCB-144).
- **MCP parity.** `CARD_INTRO` lives once, in the server instructions, instead of spliced into
  every tool description — the schema drops 31,301 → 22,769 B across 25 tools (RCB-137); four
  tools mirror their CLI counterparts — `get_log`, `get_seat`, `record_gate`, `get_gate` — and
  `list_cards` gains `size`/`parent`/`unblocked` (RCB-146); 26,155 B across 29 tools measured over
  stdio at RCB-146 (2026-09-25), and with `list_decisions` (RCB-129) it is 30 tools; MCP now speaks
  stdio JSON-RPC without `@modelcontextprotocol/sdk` at runtime, 98 → 5 production transitive
  packages (RCB-152).
- **The board UI.** `serve` fires one non-blocking rescan on the watcher's `ready`, closing the
  scan/watch gap where a file created before the first watch went unseen (RCB-125 closes K16); a
  dead server on load shows "can't reach the server" after 5 s (RCB-138); card titles clamp to 3
  lines, full title on hover (RCB-139); log timeline blocks render markdown, parsed only when
  opened (RCB-143); a text search box filters the board by title, id and label (RCB-147); a
  one-time dismissible tip strip shows on a board with at most 1 card (RCB-149); memoized cards
  and linear per-render work cut drawer-open latency 277 → 27 ms at 500 cards, and a column above
  150 cards virtualizes — sort 191 → 44 ms, DOM 4,098 → 193 nodes at N=500 (RCB-151 closes
  RCB-148); web test coverage added for the reconnect layer and wire protocol (RCB-150).
- **npm packaging.** The package page ships README and LICENSE, repo links, no source maps, no
  tracker ids in `--help` (RCB-121); CI green on `main` — suite on Node 22/24, pack-smoke on
  20/22/24 (RCB-120); per-command `--help`, parse errors with a usage block, a one-line crash,
  and a 7-line quickstart replacing a 212-line one (RCB-134); the npm README strips
  `<!-- npm:omit -->` regions and turns 13 prose doc pointers into GitHub links (RCB-135); `init`
  names its sibling verbs, the dead "Build once, then" line is gone (RCB-136); the library entry
  stops re-exporting `runCli`, so `dist/index.js` no longer bundles the CLI — 395,379 → 260,438 B,
  the packed tarball 366.0 → 339.7 kB (RCB-141); README measures the MCP SDK's install weight —
  98 production packages, 93 reachable only through `@modelcontextprotocol/sdk` (RCB-142); a
  build-time src digest clears the dist-stale false alarm after a checkout that rewrites src/
  with unchanged bytes (RCB-145).
- `@repoboard/core` is internal: not published, bundled into `repoboard`.

## [0.1.0] — 2026-09-18

### Highlights

What 0.1.0 is, plan task ids in parentheses point at the decision in `docs/BUILD-PLAN.md` §5:

- **The board as markdown files.** One card per file in `.repoboard/cards/<id>.md`, columns in
  `.repoboard/board.yml`, transitions and validation pure and I/O-free (P1.1, P1.2, P1.3, P1.4).
- **The local dashboard.** Board view with drag-and-drop columns (P3.1, P3.2), a card drawer with
  markdown body, edit, and refs resolved live from the file rather than cached (P3.3, K7), an
  activity ticker (P3.4), and a repo map: file treemap by size/language, an activity-heat overlay,
  "who is where" (a card's files glow in the assignee's color), and an import graph for JS/TS
  (P4.1, P4.2, P4.3, P4.4). A directory with no `.repoboard/` opens map-only and read-only (P7.2).
- **The CLI.** `init` (`--practices` scaffolds STATE.md, today's log, `leases.yml`, P8.3);
  `card add/move/update/list/show/ask/decide` (P2.1, decisions P8.1); `lease take/release/list`
  and `window add/list/check` (P8.2); `state` and `log` (P8.3, plus `log --last <seat>`,
  RCB-47); `seat` — the cold-start bundle for one seat in a single command (RCB-48); `check`,
  `cost` (P8.4), `archive`,
  `sync-issues` (P8.5); `serve` (P2.1), including `--root` for a foreign repo (P7.1, P7.2).
- **MCP server** (P5.1) — `repoboard mcp` over stdio, 21 tools: `list_cards`, `get_card`,
  `create_card`, `move_card`, `update_card`, `append_log`, `board_summary`, `ask_owner`,
  `record_decision`, `take_lease`, `release_lease`, `list_leases`, `add_window`, `check_window`,
  `get_state`, `set_state_section`, `append_repo_log`, `check`, `cost`, `archive_cards`,
  `sync_issues`. `docs/AGENTS.md` (P5.2) is the one page an agent needs.
- **HTTP + WebSocket API** (P2.3) — every mutation goes through the same store the CLI and MCP
  use; the watcher pushes changes to every open browser.
- **The practices layer** — the board becomes the framework for how agents work in a repo:
  decisions and owner tasks recorded directly on a card, no separate queue (P8.1); leases and
  windows for coordinating shared resources, shown in a "Now" strip (P8.2); `STATE.md` and a
  daily log per seat, `check`'s staleness and lease findings (P8.3); cold-context cost
  measurement against a configurable budget (P8.4); archiving old `done` cards and syncing a
  markdown known-issues list to cards (P8.5).
