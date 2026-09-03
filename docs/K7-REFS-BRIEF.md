# Brief: K7 — cards render the lines they reference (`refs:`), plan §11 O5

You are implementing K7(b) for `repoboard`. Read `CLAUDE.md`, plan §1 (D1, D6, D11), §2 (the
card format — `refs:` is already in the example), §3, §11 O5, `README.md` Known issues K7,
`docs/AGENTS.md`, `docs/HANDOFF.md` §0 and §7. Do NOT commit or publish.

## Why
A card today is a copy of a note that lives somewhere else (plan §5, HANDOFF, a brief, a
source file). Copies drift and cost tokens to write. The owner wants the board to pull from
where the notes are written. A card carries pointers; the board resolves them live, on request,
from the file — never cached, because the file changes without the card changing (D6 spirit).

## Ref forms (core parses these, I/O-free)
| Form | Meaning | Span |
|---|---|---|
| `path#Heading text` | markdown heading, matched on normalized text (strip `#`, trim, case-fold, collapse spaces); first heading whose normalized text **starts with** the spec | from that heading line to the line before the next heading of the same or higher level, or EOF |
| `path@Token` | a list item or paragraph: first line whose text, after list markers and `**`, **starts with** `Token` (e.g. `P6.2`, `K6`, `O1 —`) | from that line to the line before the next line that is blank, a heading, or a list item at the same or lesser indent |
| `path:L10-L20` | 1-based inclusive line range; `:L10` is one line | exactly those lines |
| `path` | whole file | all lines |

Resolution caps: 200 lines or 16 KB per ref, whichever first; a truncated result says so
(`truncated: true`). Unresolvable (heading/token not found, range past EOF, file missing or
binary or >2 MB) returns **`null` text with an `error` string — never a guess** (CLAUDE.md).

## Where it goes
- **core** (`packages/core`, no I/O): `refs?: string[]` in `CardFrontmatterSchema` and
  `OPTIONAL_CARD_KEYS`; `parseRef(spec) → Ref | {error}`; `resolveRef(ref, fileText) →
  {text, start, end, truncated} | {text: null, error}`. Exhaustive unit tests: each form, not
  found, off-by-one at the next heading, cap, CRLF input.
- **server**: `GET /api/cards/:id/refs` → `[{spec, path, start, end, text, truncated, error}]`,
  resolved on every request. **One function guards the path** — `resolveRepoPath(root, rel)` —
  and it is the only way the handler turns a spec into a filesystem path: rejects absolute
  paths, any `..` segment, anything under `.git/`, and any realpath outside `root` (symlinks).
  Text files only; reuse the scanner's binary/size rules. CLI: `card show <id> --resolve`
  prints each ref as a fenced block headed `path:start-end`. MCP `get_card` takes optional
  `resolveRefs: true` and returns the same array under `refs`. Plan §3 gains the GET route
  (additive; edit §3).
- **web**: Drawer gets a **References** section under the description: one block per ref,
  header `path:start–end` in mono, body rendered with the existing `renderMarkdown` (for `.md`
  refs) or as a `<pre>` (anything else). Fetch when the drawer opens and again on every `card`
  WS message for that id. Error state shows the spec and the error string, not nothing. Card
  tile shows a ref count next to the file count. Web test: drawer renders two refs from a
  mocked fetch and shows an error for a third.
- **docs/AGENTS.md**: a `refs:` section, placed before "file edit": the four forms, the caps,
  and the rule **"point, don't paste"** — write the note where it lives, reference it from the
  card. `README.md` "What it shows" gets one line; K7 gets struck through with the numbers below.
- **Dogfood**: convert RCB-22..26 — replace each quoted block with a `refs:` entry pointing at
  the same lines (plan §5 `@P6.1`…, plan §11 `@O1`, README `@K6`), leave a one-line body.
  Measure body bytes before and after per card (`wc -c` on the file), paste the table, and
  open each in the drawer.

## Protective controls, verified the CLAUDE.md way (perturb, read back, typecheck 0, fail in the feared direction, restore by targeted sed, read back)
1. **Path guard, the direction that matters:** remove the `..` rejection from `resolveRepoPath`;
   the http test requesting `../../etc/hosts`-style and `.git/config` refs must fail (they
   currently must assert 400 and `text: null`).
2. **Heading span off-by-one:** make the heading resolver include the next heading line; the
   core test must fail on the span end.
Paste all four outputs for each.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0, no `any` added, `biome check --write` run.
Test count before/after. Both controls. `pnpm build`, then on the built binary: `card show
RCB-25 --resolve` output pasted; `curl localhost:4242/api/cards/RCB-25/refs | head -c 600`
pasted; `curl 'localhost:4242/api/cards/RCB-25/refs'` after appending a line to the referenced
plan section shows the new line (live, not cached) — paste both. One screenshot
`docs/drawer-refs.png` (Chrome tools, dark theme, the RCB-25 drawer open showing References)
that you looked at. Nothing under port 4242 when you finish. Board: move RCB-27 to `doing` with
`--as claude/refs-agent` and set `assignee:`; to `review` when done with a `## Log` line.
Report measurements, not verdicts; state plainly anything you decided on your own.
