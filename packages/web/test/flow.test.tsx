/**
 * RCB-98 (plan docs/SYSTEMS-FLOW-PLAN.md §3.4): the Flow view — third top-level view, beside
 * Board and Map. Follows `map.test.tsx`'s pattern (seed the store with a raw `dispatch`, no
 * socket) and `refs.test.tsx`'s pattern for mocking `fetch` under the drawer's live pointer
 * resolution.
 *
 * The fixture text below is pasted from `packages/core/test/fixtures/systems/{two-env,none-prod}.yml`
 * (RCB-95's own fixtures) and parsed through `parseSystems`, per the brief — not re-derived.
 */
import {
  defaultBoardConfig,
  layoutSystems,
  parseSystems,
  type ResolvedRef,
  SYSTEM_KINDS,
  type SystemsDoc,
} from '@repoboard/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefsList } from '../src/components/RefsList.jsx';
import { DEFAULT_SIZE } from '../src/map/useSize.js';
import { createMockTransport } from '../src/mock/index.js';
import { createStore, type Store } from '../src/store.js';
import {
  connectionsForEdges,
  EDGE_HIT_W,
  envNoteLine,
  findConnection,
  fitText,
  flowContentSize,
  hopRect,
  pathDrawn,
  pathSteps,
  polylineMidpoint,
} from '../src/views/Flow.jsx';
import { KIND_META } from '../src/views/flow-kinds.jsx';
import { clearedFlowSearch, flowSearch, parseFlowSelection } from '../src/views/flow-url.js';
import { fitTransform, MAX_K, MIN_K, revealRect, zoomAbout } from '../src/views/usePanZoom.js';
import type { RepoGitPayload } from '../src/wire.js';
import { card, renderApp, testStore } from './helpers.jsx';

const TWO_ENV_YML = `environments:
  dev:  { note: "vite dev :5173 + wrangler dev :8700 + local postgres :5499" }
  prod: { note: "Cloudflare Workers; Neon via Hyperdrive" }
systems:
  - id: web
    name: marketing site
    kind: client
    layer: client
    env: [dev, prod]
    runtime: { dev: "vite dev", prod: "static hosting" }
    pointers: ["apps/web/src"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: gateway
    name: edge gateway
    kind: worker
    layer: edge
    env: [dev, prod]
    runtime: { dev: "wrangler dev", prod: "Cloudflare Workers" }
    owner: backend
    pointers: ["apps/gateway/src/index.ts"]
    docs: ["docs/BUILD-PLAN.md#§3"]
    why: null
    source: { detected: "wrangler.jsonc", at: "2026-09-22T00:00:00Z" }
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    runtime: { dev: "node server", prod: "Cloudflare Workers" }
    owner: null
    pointers: []
    docs: []
    why: "core business logic"
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: worker-jobs
    name: background jobs
    kind: job
    layer: app
    env: [prod]
    runtime: { prod: "queue consumer" }
    source: { detected: "package.json", at: "2026-09-22T00:00:00Z" }
  - id: postgres
    name: primary database
    kind: db
    layer: data
    env: [dev, prod]
    runtime: { dev: "local postgres :5499", prod: "Neon via Hyperdrive" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { detected: "wrangler.jsonc@hyperdrive", at: "2026-09-22T00:00:00Z" }
  - id: sendgrid
    name: transactional email
    kind: email
    layer: external
    env: [dev]
    runtime: { dev: "sandbox key" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: gateway
    via: "HTTPS"
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: gateway
    to: api
    via: "HTTP internal"
    env: [dev, prod]
    source: { detected: "wrangler.jsonc", at: "2026-09-22T00:00:00Z" }
  - from: api
    to: postgres
    via: "Hyperdrive binding HYPERDRIVE"
    env: [dev, prod]
    source: { detected: "wrangler.jsonc@hyperdrive", at: "2026-09-22T00:00:00Z" }
  - from: worker-jobs
    to: postgres
    env: [prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: api
    to: sendgrid
    via: "SMTP relay"
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;

const NONE_PROD_YML = `environments:
  dev:  { note: "local dev only" }
  prod: { none: "local-only by design — speed and tokens" }
systems:
  - id: cli
    name: repoboard CLI
    kind: tool
    layer: client
    env: [dev]
    runtime: { dev: "node dist/cli.js" }
    owner: null
    pointers: ["packages/server/src/cli.ts"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: server
    name: repoboard server
    kind: service
    layer: app
    env: [dev]
    runtime: { dev: "node dist/server.js" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: sqlite
    name: local state files
    kind: storage
    layer: data
    env: [dev]
    runtime: { dev: "filesystem" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: cli
    to: server
    via: "child process"
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: server
    to: sqlite
    via: "fs read/write"
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;

/** RCB-161 slice 2: one live box (`web`), one non-live box (`svc`, `status: planned`) with three
 * `unblocked_by` ids (an open decision, a next step, an unknown id), and one non-live connection
 * (`status: planned`, `env: [dev]` so it is ALSO one-env-dashed in "both" — the dotted `1 4` must
 * win over the one-env `4 3`). */
const STATUS_YML = `environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: web
    name: web client
    kind: client
    layer: client
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: svc
    name: planned service
    kind: service
    layer: app
    env: [dev, prod]
    status: planned
    unblocked_by: ["RB-1", "RB-2", "RB-99"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: svc
    env: [dev]
    status: planned
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;

function parsedDoc(text: string): SystemsDoc {
  const result = parseSystems(text);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.errors.join('; ')}`);
  return result.doc;
}

const TWO_ENV = () => parsedDoc(TWO_ENV_YML);
const NONE_PROD = () => parsedDoc(NONE_PROD_YML);
const STATUS_DOC = () => parsedDoc(STATUS_YML);

/** RB-1: an open decision. RB-2/RB-3: a parent with one not-done, not-blocked step. RB-99 is
 * deliberately absent (the "unknown id" case). */
function statusCards() {
  return [
    card('RB-1', 'decide', {
      title: 'Pick a path',
      decision: {
        question: 'Which way?',
        options: [
          { letter: 'A', text: 'go left' },
          { letter: 'B', text: 'go right' },
        ],
        askedBy: 'owner',
        askedAt: '2026-09-22T00:00:00Z',
        returnTo: 'todo',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    }),
    card('RB-2', 'backlog', { title: 'Ship the widget' }),
    card('RB-3', 'todo', { title: 'Do the first step', parent: 'RB-2', phase: 'PH.1' }),
  ];
}

/** Seeds a board snapshot AND the systems payload in one message — `helpers.jsx`'s `snapshot()`
 * has no `systems` parameter (out of this brief's file list), so this mirrors `map.test.tsx` /
 * `topbar.test.tsx`'s own pattern of dispatching a full `snapshot` message directly. */
function openFlow(
  systems: { doc: SystemsDoc | null; errors: string[]; exists: boolean },
  cards = [card('RB-1', 'todo')],
  hasBoard = true,
): { store: Store } {
  const store = testStore();
  store.dispatch({
    type: 'snapshot',
    board: { config: defaultBoardConfig(), cards, hasBoard },
    repo: null,
    systems,
  });
  store.setView('flow');
  renderApp(store);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());
// RCB-176: the Flow view writes `?view=flow…` into the address bar, and the store reads it back
// when it is made — so a test must never leave one behind for the next test's store.
afterEach(() => window.history.replaceState(null, '', '/'));

function stubFetch(byUrl: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const payload = byUrl[url];
    if (payload === undefined) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, json: async () => payload, url };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Flow view (RCB-98)', () => {
  it('1. the Flow tab renders and clicking it switches to the Flow view', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: null,
    });
    renderApp(store);
    expect(screen.queryByTestId('flow')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Flow' }));
    expect(store.getState().view).toBe('flow');
    // A control that removes the <FlowView> branch from App.tsx leaves this assertion with
    // nothing to find (MapView has no `data-testid="flow"`), so this is the one that catches it.
    expect(screen.getByTestId('flow')).toBeInTheDocument();
  });

  it('2. no systems.yml (`exists: false`) shows the one-line note, no <svg>', () => {
    openFlow({ doc: null, errors: [], exists: false });
    expect(screen.getByTestId('flow-no-file')).toHaveTextContent(
      'no systems.yml yet — repoboard systems detect proposes one',
    );
    expect(screen.queryByTestId('flow-svg')).toBeNull();
  });

  it('3. an invalid systems.yml shows every error in a <pre>, no <svg>', () => {
    const errors = [
      'systems[0] (id "bad"): unknown kind "lambda"',
      'connections[0]: source system "x" is unknown',
    ];
    openFlow({ doc: null, errors, exists: true });
    const block = screen.getByTestId('flow-errors');
    for (const e of errors) expect(block).toHaveTextContent(e);
    expect(screen.queryByTestId('flow-svg')).toBeNull();
  });

  it('4. two-env doc: "both" is 6 boxes/5 edges with worker-jobs+sendgrid dashed; "prod" is 5 boxes; "dev" is 5 boxes, none dashed', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    const svg = screen.getByTestId('flow-svg');
    // RCB-174: the svg fills the canvas; the diagram's size is the inner group's transform now.
    expect(screen.getByTestId('flow-viewport').getAttribute('transform')).toMatch(/^translate\(/);
    expect(svg.querySelectorAll('rect')).toHaveLength(6);
    expect(svg.querySelectorAll('polyline')).toHaveLength(5);
    const dashedBoxIds = [...svg.querySelectorAll('.flow-box')]
      .filter((g) => g.querySelector('rect')?.getAttribute('data-dashed') === 'true')
      .map((g) => g.getAttribute('data-box'));
    expect(dashedBoxIds.sort()).toEqual(['sendgrid', 'worker-jobs']);
    expect(svg.querySelectorAll('polyline[data-dashed="true"]').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(screen.getByTestId('flow-svg').querySelectorAll('rect')).toHaveLength(5);

    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    const devSvg = screen.getByTestId('flow-svg');
    expect(devSvg.querySelectorAll('rect')).toHaveLength(5);
    expect(devSvg.querySelectorAll('[data-dashed="true"]')).toHaveLength(0);
  });

  it('5. a `none` prod: clicking "prod" shows the note in prose (no <svg>); "both" has nothing dashed', () => {
    openFlow({ doc: NONE_PROD(), errors: [], exists: true });
    const bothSvg = screen.getByTestId('flow-svg');
    expect(bothSvg.querySelectorAll('[data-dashed="true"]')).toHaveLength(0);

    const prodBtn = screen.getByRole('button', { name: 'prod' });
    expect(prodBtn.getAttribute('title')).toBe('local-only by design — speed and tokens');
    fireEvent.click(prodBtn);
    expect(screen.queryByTestId('flow-svg')).toBeNull();
    expect(screen.getByText('local-only by design — speed and tokens')).toBeInTheDocument();
  });

  it('6. clicking a box opens its drawer (fields + connection count); backlinks resolve by pointer, fetched refs are mocked', async () => {
    const fetchMock = stubFetch({
      '/api/systems/gateway/refs': [
        {
          spec: 'apps/gateway/src/index.ts',
          path: 'apps/gateway/src/index.ts',
          start: 1,
          end: 1,
          text: 'export {};',
          truncated: false,
          error: null,
        },
      ],
      '/api/systems/gateway/tests': {
        pointers: [
          { pointer: 'apps/gateway/src/index.ts', tests: ['test/gateway.test.ts'], reason: null },
        ],
        files: 1,
        source: 'static: test files that import or name the pointer, read live',
        line: 'tests: 1 file',
        measured: {
          pointers: [],
          pct: null,
          source: 'coverage: no report at coverage/coverage-summary.json',
          line: 'lines: n/a (no coverage report)',
        },
      },
    });
    const backlinkCard = card('RB-2', 'todo', { refs: ['apps/gateway/src/index.ts#x'] });
    const { store } = openFlow({ doc: TWO_ENV(), errors: [], exists: true }, [
      card('RB-1', 'todo'),
      backlinkCard,
    ]);

    fireEvent.click(screen.getByTestId('flow-svg').querySelector('[data-box="api"]') as Element);
    const drawer = screen.getByTestId('flow-drawer');
    expect(within(drawer).getByText('service · app · dev+prod')).toBeInTheDocument();
    expect(within(drawer).getByText('Connections (3)')).toBeInTheDocument();
    // `api`'s pointers are [] — no dead fetch for a system with nothing to resolve.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTestId('flow-svg').querySelector('[data-box="gateway"]') as Element,
    );
    const gatewayDrawer = await screen.findByTestId('flow-drawer');
    expect(fetchMock).toHaveBeenCalledWith('/api/systems/gateway/refs');
    const refsSection = await screen.findByTestId('flow-drawer-refs');
    // Waits for resolution: the `· N lines` span only exists once refs.kind === 'ok'.
    await within(refsSection).findByText(/1 lines/);
    expect(refsSection).toHaveTextContent('apps/gateway/src/index.ts:1');
    expect(refsSection.querySelectorAll('pre')).toHaveLength(0);
    expect(refsSection).not.toHaveTextContent('export {};');

    const toggle = within(refsSection).getByRole('button', { name: 'show' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    await within(refsSection).findByText('export {};');
    expect(refsSection.querySelectorAll('pre')).toHaveLength(1);

    fireEvent.click(within(refsSection).getByRole('button', { name: 'hide' }));
    expect(refsSection.querySelectorAll('pre')).toHaveLength(0);

    const backlinks = within(gatewayDrawer).getByTestId('flow-drawer-backlinks');
    expect(backlinks).toHaveTextContent('RB-2');
    expect(backlinks).toHaveTextContent(backlinkCard.title);
    expect(within(backlinks).queryByText(/RB-1\b/)).toBeNull();

    fireEvent.click(within(backlinks).getByText(new RegExp(backlinkCard.title)));
    expect(store.getState().selectedId).toBe('RB-2');
    expect(store.getState().view).toBe('board');
  });

  it('7. the `api` drawer (no pointers) shows the meta line, connection strongs+via, and provenance', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    fireEvent.click(screen.getByTestId('flow-svg').querySelector('[data-box="api"]') as Element);
    const drawer = screen.getByTestId('flow-drawer');
    expect(within(drawer).getByText('service · app · dev+prod')).toBeInTheDocument();
    expect(within(drawer).getByText('Connections (3)')).toBeInTheDocument();
    // Every one of api's 3 connections names api as `from` or `to` — each <li> bolds it.
    expect(within(drawer).getAllByText('api', { selector: 'strong' })).toHaveLength(3);
    expect(within(drawer).getAllByText(/^via /)).toHaveLength(3);
    expect(drawer).toHaveTextContent('hand: owner');
  });

  it('8. no systems.yml + hasBoard: the "Plan the systems map" button confirms inline, then creates via POST /api/systems/plan', async () => {
    const fetchMock = stubFetch({
      '/api/systems/plan': { parent: card('RB-9', 'todo'), steps: [] },
    });
    const { store } = openFlow(
      { doc: null, errors: [], exists: false },
      [card('RB-1', 'todo')],
      true,
    );
    expect(screen.getByTestId('flow-no-file')).toBeInTheDocument();
    const planButton = screen.getByTestId('flow-plan');
    expect(planButton).toHaveTextContent('Plan the systems map');

    fireEvent.click(planButton);
    const confirm = screen.getByTestId('flow-plan-confirm');
    expect(confirm).toHaveTextContent('Create 4 cards');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('flow-plan-confirm')).toBeNull();
    expect(screen.getByTestId('flow-plan')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('flow-plan'));
    fireEvent.click(screen.getByRole('button', { name: 'Create 4 cards' }));
    await screen.findByTestId('board');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/systems/plan',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(store.getState().view).toBe('board');
    expect(store.getState().selectedId).toBe('RB-9');
  });

  it('9. CONTROL: no systems.yml + no board offers no "Plan the systems map" button', () => {
    openFlow({ doc: null, errors: [], exists: false }, [card('RB-1', 'todo')], false);
    expect(screen.getByTestId('flow-no-file')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-plan')).toBeNull();
    expect(screen.queryByTestId('flow-plan-confirm')).toBeNull();
  });

  it('10. Tests section: gateway shows the line then reveals files on show/hide; api (no pointers) shows n/a with no fetch', async () => {
    const fetchMock = stubFetch({
      '/api/systems/gateway/refs': [
        {
          spec: 'apps/gateway/src/index.ts',
          path: 'apps/gateway/src/index.ts',
          start: 1,
          end: 1,
          text: 'export {};',
          truncated: false,
          error: null,
        },
      ],
      '/api/systems/gateway/tests': {
        pointers: [
          { pointer: 'apps/gateway/src/index.ts', tests: ['test/gateway.test.ts'], reason: null },
        ],
        files: 1,
        source: 'static: test files that import or name the pointer, read live',
        line: 'tests: 1 file',
        measured: {
          pointers: [{ pointer: 'apps/gateway/src/index.ts', pct: 92.3, reason: null }],
          pct: 92.3,
          source: 'coverage: coverage/coverage-summary.json @ 2026-09-22T00:00:00.000Z',
          line: 'lines: 92.3% covered',
        },
      },
    });
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });

    fireEvent.click(screen.getByTestId('flow-svg').querySelector('[data-box="api"]') as Element);
    const apiDrawer = screen.getByTestId('flow-drawer');
    const apiTests = within(apiDrawer).getByTestId('flow-drawer-tests');
    expect(apiTests).toHaveTextContent('tests: n/a (no pointers)');
    // `api`'s pointers are [] — no dead fetch for a system with nothing to resolve.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTestId('flow-svg').querySelector('[data-box="gateway"]') as Element,
    );
    await screen.findByTestId('flow-drawer');
    const testsSection = await screen.findByTestId('flow-drawer-tests');
    await within(testsSection).findByText('tests: 1 file');
    // RCB-113: the measured (coverage) line sits right under the static line, unconditionally.
    await within(testsSection).findByText('lines: 92.3% covered');
    expect(testsSection).not.toHaveTextContent('test/gateway.test.ts');

    fireEvent.click(within(testsSection).getByRole('button', { name: 'show' }));
    await within(testsSection).findByText(/test\/gateway\.test\.ts/);
    expect(testsSection).toHaveTextContent('apps/gateway/src/index.ts');
    expect(testsSection).toHaveTextContent(
      'static: test files that import or name the pointer, read live',
    );
    // RCB-113: the open toggle also gains each pointer's measured pct and the coverage source.
    expect(testsSection).toHaveTextContent(
      'apps/gateway/src/index.ts — 1: test/gateway.test.ts · 92.3%',
    );
    expect(testsSection).toHaveTextContent(
      'coverage: coverage/coverage-summary.json @ 2026-09-22T00:00:00.000Z',
    );

    fireEvent.click(within(testsSection).getByRole('button', { name: 'hide' }));
    expect(testsSection).not.toHaveTextContent('test/gateway.test.ts');
    expect(testsSection).not.toHaveTextContent('static: test files');
  });

  it('11. CONTROL: a 500 from /tests shows the error block without taking the drawer down (backlinks still render)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/systems/gateway/refs') {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              spec: 'apps/gateway/src/index.ts',
              path: 'apps/gateway/src/index.ts',
              start: 1,
              end: 1,
              text: 'export {};',
              truncated: false,
              error: null,
            },
          ],
          url,
        };
      }
      if (url === '/api/systems/gateway/tests') {
        return { ok: false, status: 500, json: async () => ({}), url };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    fireEvent.click(
      screen.getByTestId('flow-svg').querySelector('[data-box="gateway"]') as Element,
    );
    const drawer = await screen.findByTestId('flow-drawer');
    const testsSection = await screen.findByTestId('flow-drawer-tests');
    await within(testsSection).findByText('could not load tests');
    expect(within(testsSection).getByRole('alert')).toBeInTheDocument();
    // A failure in the tests fetch must not take the rest of the drawer down.
    expect(within(drawer).getByTestId('flow-drawer-backlinks')).toBeInTheDocument();
  });

  it('12. CONTROL (RCB-112 B wart): a pointer with an empty tests array reads "— none", not "— 0:"', async () => {
    const fetchMock = stubFetch({
      '/api/systems/gateway/refs': [
        {
          spec: 'apps/gateway/src/index.ts',
          path: 'apps/gateway/src/index.ts',
          start: 1,
          end: 1,
          text: 'export {};',
          truncated: false,
          error: null,
        },
      ],
      '/api/systems/gateway/tests': {
        pointers: [{ pointer: 'apps/gateway/src/index.ts', tests: [], reason: null }],
        files: 0,
        source: 'static: test files that import or name the pointer, read live',
        line: 'tests: none found',
        measured: {
          pointers: [],
          pct: null,
          source: 'coverage: no report at coverage/coverage-summary.json',
          line: 'lines: n/a (no coverage report)',
        },
      },
      // RCB-178: gateway also has a `docs[]` entry and pointers, so its drawer asks for both.
      '/api/systems/gateway/docs': [],
      '/api/git': { root: '/work/repo', web: null, head: null },
    });
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });

    fireEvent.click(
      screen.getByTestId('flow-svg').querySelector('[data-box="gateway"]') as Element,
    );
    const testsSection = await screen.findByTestId('flow-drawer-tests');
    await within(testsSection).findByText('tests: none found');

    fireEvent.click(within(testsSection).getByRole('button', { name: 'show' }));
    await within(testsSection).findByText('apps/gateway/src/index.ts — none');
    expect(testsSection).not.toHaveTextContent('— 0:');
    // refs + tests, and (RCB-178) docs + git: one fetch each, none repeated.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('13. RCB-161 slice 2: a planned box gets data-status/badge/dotted dasharray; a live box has none of them', () => {
    openFlow({ doc: STATUS_DOC(), errors: [], exists: true }, statusCards());
    const svg = screen.getByTestId('flow-svg');

    const svcBox = svg.querySelector('[data-box="svc"]') as Element;
    expect(svcBox.getAttribute('data-status')).toBe('planned');
    expect(svcBox.classList.contains('flow-box--planned')).toBe(true);
    expect(svcBox.querySelector('rect')?.getAttribute('stroke-dasharray')).toBe('1 4');
    expect(within(svcBox as HTMLElement).getByText('planned')).toHaveClass('flow-box__badge');

    const webBox = svg.querySelector('[data-box="web"]') as Element;
    expect(webBox.getAttribute('data-status')).toBeNull();
    expect(webBox.classList.contains('flow-box--planned')).toBe(false);
    expect(webBox.classList.contains('flow-box--blocked')).toBe(false);
    expect(webBox.querySelector('rect')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(within(webBox as HTMLElement).queryByText('planned')).toBeNull();
  });

  it('14. RCB-161 slice 2: a planned, one-env edge is dotted (1 4) not dashed (4 3); data-dashed unchanged', () => {
    openFlow({ doc: STATUS_DOC(), errors: [], exists: true }, statusCards());
    const svg = screen.getByTestId('flow-svg');
    const edge = svg.querySelector('[data-edge="web-svc"]') as Element;
    expect(edge.getAttribute('data-status')).toBe('planned');
    expect(edge.getAttribute('data-dashed')).toBe('true');
    expect(edge.getAttribute('stroke-dasharray')).toBe('1 4');
    expect(edge.classList.contains('flow-edge--planned')).toBe(true);
  });

  it('15. RCB-161 slice 2: drawer "Unblocked by" — open decision, next step, unknown id; none on a live row', () => {
    const { store } = openFlow({ doc: STATUS_DOC(), errors: [], exists: true }, statusCards());
    const svg = screen.getByTestId('flow-svg');

    fireEvent.click(svg.querySelector('[data-box="svc"]') as Element);
    const drawer = screen.getByTestId('flow-drawer');
    expect(within(drawer).getByText('service · app · dev+prod · planned')).toBeInTheDocument();
    const section = within(drawer).getByTestId('flow-drawer-unblockers');
    expect(within(section).getByText('Unblocked by (3)')).toBeInTheDocument();

    // RB-1: an open decision — question and both option lines.
    expect(
      within(section).getByRole('button', { name: 'RB-1 — Pick a path [decide]' }),
    ).toBeInTheDocument();
    expect(within(section).getByText('decision: Which way?')).toBeInTheDocument();
    expect(within(section).getByText('A: go left')).toBeInTheDocument();
    expect(within(section).getByText('B: go right')).toBeInTheDocument();

    // RB-2: a next step (RB-3), also a button.
    expect(
      within(section).getByRole('button', { name: 'RB-2 — Ship the widget [backlog]' }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('button', { name: 'next step: RB-3 Do the first step' }),
    ).toBeInTheDocument();

    // RB-99: unknown id, no button.
    expect(within(section).getByText('RB-99 (not on this board)')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /RB-99/ })).toBeNull();

    // Clicking the card button opens it on the board.
    fireEvent.click(within(section).getByRole('button', { name: 'RB-1 — Pick a path [decide]' }));
    expect(store.getState().selectedId).toBe('RB-1');
    expect(store.getState().view).toBe('board');
  });

  it('16. CONTROL: a live row with no unblockedBy has no "Unblocked by" section', () => {
    openFlow({ doc: STATUS_DOC(), errors: [], exists: true }, statusCards());
    fireEvent.click(screen.getByTestId('flow-svg').querySelector('[data-box="web"]') as Element);
    const drawer = screen.getByTestId('flow-drawer');
    expect(within(drawer).getByText('client · client · dev+prod')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('flow-drawer-unblockers')).toBeNull();
  });

  it('17. RCB-161 slice 2: a blocked row with no unblockers says so; a connection lists its own unblockers', () => {
    const doc = parsedDoc(`environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: web
    name: web client
    kind: client
    layer: client
    env: [dev, prod]
    status: blocked
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: svc
    name: service
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: svc
    env: [dev, prod]
    status: blocked
    unblocked_by: ["RB-1"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`);
    openFlow({ doc, errors: [], exists: true }, statusCards());
    fireEvent.click(screen.getByTestId('flow-svg').querySelector('[data-box="web"]') as Element);
    const drawer = screen.getByTestId('flow-drawer');
    const section = within(drawer).getByTestId('flow-drawer-unblockers');
    expect(within(section).getByText('Unblocked by (0)')).toBeInTheDocument();
    expect(within(section).getByText('Nothing recorded unblocks this yet.')).toBeInTheDocument();
    // The connection's line carries its status and its own unblocker, outside the section.
    expect(
      within(drawer).getByText(
        (_, el) => el?.tagName === 'DIV' && el.textContent === 'web → svc · blocked',
      ),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole('button', { name: 'RB-1 — Pick a path [decide]' }),
    ).toBeInTheDocument();
    expect(within(section).queryByRole('button')).toBeNull();
  });
});

/** Ten systems in ONE layer = ten columns: 2,593 px wide (a member's), one connection. Wider than
 * `DEFAULT_SIZE` (960), so a Fit has to scale it down. */
function wideYml(n = 10): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const id = `s${String(i + 1).padStart(2, '0')}`;
    return `  - id: ${id}
    name: service ${i + 1}
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
  }).join('');
  return `environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
${rows}connections:
  - from: s01
    to: s02
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
}

/** The canvas transform, read back from the inner `<g>` (offsets rounded to 0.01, scale to 0.001). */
function viewportTransform(): { x: number; y: number; k: number } {
  const attr = screen.getByTestId('flow-viewport').getAttribute('transform') ?? '';
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(attr);
  if (!m) throw new Error(`unparseable transform: ${attr}`);
  return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
}

function boxEl(id: string): Element {
  return screen.getByTestId('flow-svg').querySelector(`[data-box="${id}"]`) as Element;
}
function edgeEl(id: string): Element {
  return screen.getByTestId('flow-svg').querySelector(`[data-edge="${id}"]`) as Element;
}
function dimmedBoxes(): string[] {
  return [...screen.getByTestId('flow-svg').querySelectorAll('.flow-box--dim')]
    .map((g) => g.getAttribute('data-box') ?? '')
    .sort();
}
function dimmedEdges(): string[] {
  return [...screen.getByTestId('flow-svg').querySelectorAll('.flow-edge--dim')]
    .map((g) => g.getAttribute('data-edge') ?? '')
    .sort();
}

describe('Flow view navigation (RCB-174)', () => {
  it('18. first open is Fit: a wide diagram is scaled to the canvas, and Fit / 100% return and leave it', () => {
    const doc = parsedDoc(wideYml());
    const content = flowContentSize(layoutSystems(doc, 'both'));
    // The fixture must be wider than the (jsdom fallback) canvas, or "fits" proves nothing.
    expect(content.w).toBeGreaterThan(DEFAULT_SIZE.w);
    openFlow({ doc, errors: [], exists: true });

    const expected = fitTransform(content, DEFAULT_SIZE);
    const first = viewportTransform();
    expect(first.k).toBeCloseTo(expected.k, 2);
    expect(first.x).toBeCloseTo(expected.x, 1);
    expect(first.y).toBeCloseTo(expected.y, 1);
    // Independently of fitTransform: shrunk, inside the clamp, and the whole width is on screen.
    expect(first.k).toBeLessThan(1);
    expect(first.k).toBeGreaterThanOrEqual(MIN_K);
    expect(first.x).toBeGreaterThanOrEqual(0);
    expect(first.x + content.w * first.k).toBeLessThanOrEqual(DEFAULT_SIZE.w + 0.01);

    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(viewportTransform().k).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    const refit = viewportTransform();
    expect(refit.k).toBeCloseTo(first.k, 3);
    expect(refit.x).toBeCloseTo(first.x, 1);
    expect(refit.y).toBeCloseTo(first.y, 1);
  });

  it('19. wheel zooms in and out about the cursor and is clamped to 0.25..3; +/- step by 1.25', () => {
    openFlow({ doc: parsedDoc(wideYml()), errors: [], exists: true });
    const canvas = screen.getByTestId('flow-canvas');
    const fitK = viewportTransform().k;

    fireEvent.wheel(canvas, { deltaY: -300, clientX: 200, clientY: 100 });
    const zoomedIn = viewportTransform().k;
    expect(zoomedIn).toBeGreaterThan(fitK);
    expect(zoomedIn).toBeLessThanOrEqual(MAX_K);
    fireEvent.wheel(canvas, { deltaY: 300, clientX: 200, clientY: 100 });
    expect(viewportTransform().k).toBeCloseTo(fitK, 2);

    fireEvent.wheel(canvas, { deltaY: -100000, clientX: 200, clientY: 100 });
    expect(viewportTransform().k).toBeCloseTo(MAX_K, 3);
    fireEvent.wheel(canvas, { deltaY: 100000, clientX: 200, clientY: 100 });
    expect(viewportTransform().k).toBeCloseTo(MIN_K, 3);

    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(viewportTransform().k).toBeCloseTo(1.25, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(viewportTransform().k).toBeCloseTo(0.8, 2);
  });

  it('20. dragging the background pans; the click that ends a drag selects nothing, a plain click still does', () => {
    openFlow({ doc: parsedDoc(wideYml()), errors: [], exists: true });
    const canvas = screen.getByTestId('flow-canvas');
    const t0 = viewportTransform();

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 130 });
    const t1 = viewportTransform();
    expect(t1.x).toBeCloseTo(t0.x + 50, 1);
    expect(t1.y).toBeCloseTo(t0.y + 30, 1);
    expect(t1.k).toBe(t0.k);
    fireEvent.pointerUp(window, { pointerId: 1 });

    fireEvent.click(boxEl('s03'));
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    fireEvent.click(boxEl('s03'));
    expect(screen.getByTestId('flow-drawer')).toBeInTheDocument();
  });

  it('21. keyboard on the canvas: f fits, 0 is 100%, Esc clears focus', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    const canvas = screen.getByTestId('flow-canvas');
    const fitK = viewportTransform().k;

    fireEvent.keyDown(canvas, { key: '0' });
    expect(viewportTransform().k).toBe(1);
    fireEvent.keyDown(canvas, { key: 'f' });
    expect(viewportTransform().k).toBeCloseTo(fitK, 3);

    fireEvent.click(boxEl('api'));
    expect(dimmedBoxes()).not.toHaveLength(0);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(dimmedBoxes()).toHaveLength(0);
    // Esc clears the focus only; the drawer stays open.
    expect(screen.getByTestId('flow-drawer')).toBeInTheDocument();
  });

  it('22. filter (id, name, kind; case-insensitive) dims non-matching boxes; an edge stays lit only when both ends match', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    const filter = screen.getByTestId('flow-filter');
    expect(dimmedBoxes()).toHaveLength(0);
    expect(dimmedEdges()).toHaveLength(0);

    // By kind and id: gateway (kind worker) and worker-jobs (id). No edge joins the two.
    fireEvent.change(filter, { target: { value: 'WORKER' } });
    expect(dimmedBoxes()).toEqual(['api', 'postgres', 'sendgrid', 'web']);
    expect(boxEl('gateway').classList.contains('flow-box--dim')).toBe(false);
    expect(boxEl('worker-jobs').classList.contains('flow-box--dim')).toBe(false);
    expect(dimmedEdges()).toHaveLength(5);

    // 'i' is in web ("marketing site"), api ("api service"), postgres ("primary database") and
    // sendgrid (its id) — and in none of gateway, worker-jobs. api-postgres and api-sendgrid have
    // both ends matching, so they stay lit; the three edges touching gateway/worker-jobs dim.
    fireEvent.change(filter, { target: { value: 'i' } });
    expect(dimmedBoxes()).toEqual(['gateway', 'worker-jobs']);
    expect(dimmedEdges()).toEqual(['gateway-api', 'web-gateway', 'worker-jobs-postgres']);
    expect(edgeEl('api-postgres').classList.contains('flow-edge--dim')).toBe(false);

    // Whitespace only is no filter at all.
    fireEvent.change(filter, { target: { value: '   ' } });
    expect(dimmedBoxes()).toHaveLength(0);
    expect(dimmedEdges()).toHaveLength(0);
  });

  it('23. clicking a box dims all but it and its direct neighbours; the background, or closing the drawer, clears that', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    expect(dimmedBoxes()).toHaveLength(0);

    // api's neighbours: gateway (from), postgres and sendgrid (to). web and worker-jobs are not.
    fireEvent.click(boxEl('api'));
    expect(dimmedBoxes()).toEqual(['web', 'worker-jobs']);
    expect(dimmedEdges()).toEqual(['web-gateway', 'worker-jobs-postgres']);
    expect(edgeEl('gateway-api').classList.contains('flow-edge--dim')).toBe(false);
    expect(edgeEl('api-sendgrid').classList.contains('flow-edge--dim')).toBe(false);

    // Background click: focus clears, the drawer stays.
    fireEvent.click(screen.getByTestId('flow-canvas'));
    expect(dimmedBoxes()).toHaveLength(0);
    expect(dimmedEdges()).toHaveLength(0);
    expect(screen.getByTestId('flow-drawer')).toBeInTheDocument();

    // Clicking a box focuses it again (a click on a box is not a background click).
    fireEvent.click(boxEl('postgres'));
    expect(dimmedBoxes()).toEqual(['gateway', 'sendgrid', 'web']);

    // Closing the drawer clears focus too.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    expect(dimmedBoxes()).toHaveLength(0);
  });

  it('24. an open drawer narrows the view (the class the CSS pads by --drawer-w) and pans a hidden selected box into it', () => {
    // jsdom has no layout: a canvas inside `.flow--drawer` measures 520 wide, otherwise 960.
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const width = this.closest('.flow--drawer') ? 520 : 960;
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width,
          height: 600,
          right: width,
          bottom: 600,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      openFlow({ doc: parsedDoc(wideYml()), errors: [], exists: true });
      const flow = screen.getByTestId('flow');
      expect(flow.classList.contains('flow--drawer')).toBe(false);

      // At 100% about the centre, the last column (s10) is far to the right of a 960-wide canvas.
      fireEvent.click(screen.getByRole('button', { name: '100%' }));
      const before = viewportTransform();
      const rectX = Number(boxEl('s10').querySelector('rect')?.getAttribute('x'));
      expect(before.x + rectX * before.k).toBeGreaterThan(960);

      fireEvent.click(boxEl('s10'));
      expect(flow.classList.contains('flow--drawer')).toBe(true);
      const after = viewportTransform();
      expect(after.k).toBe(before.k);
      expect(after.x + rectX * after.k).toBeGreaterThanOrEqual(0);
      expect(after.x + (rectX + 170) * after.k).toBeLessThanOrEqual(520);

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(flow.classList.contains('flow--drawer')).toBe(false);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('25. CONTROL: revealRect leaves a box that is already inside alone (same object), moves a hidden one the least, never zooms', () => {
    const view = { w: 500, h: 400 };
    const t = { k: 1, x: 0, y: 0 };
    expect(revealRect(t, { x: 100, y: 100, w: 100, h: 50 }, view)).toBe(t);
    // Off the right: right edge (700) goes to view.w - 16 = 484.
    expect(revealRect(t, { x: 600, y: 100, w: 100, h: 50 }, view)).toEqual({ k: 1, x: -216, y: 0 });
    // Off the left, at k=1 with x=-300: left edge (-200) goes to 16.
    expect(revealRect({ k: 1, x: -300, y: 0 }, { x: 100, y: 100, w: 100, h: 50 }, view)).toEqual({
      k: 1,
      x: -84,
      y: 0,
    });
    // Off the bottom.
    expect(revealRect(t, { x: 100, y: 500, w: 100, h: 50 }, view)).toEqual({ k: 1, x: 0, y: -166 });
    // Wider than the view: left-aligned at the margin.
    expect(revealRect(t, { x: 0, y: 100, w: 800, h: 50 }, view).x).toBe(16);
  });

  it('26. CONTROL: zoomAbout keeps the content point under the cursor fixed, and clamps', () => {
    const t = { k: 0.5, x: 30, y: -20 };
    const at = { x: 200, y: 120 };
    const c = { x: (at.x - t.x) / t.k, y: (at.y - t.y) / t.k };
    const z = zoomAbout(t, 1.5, at);
    expect(z.k).toBe(1.5);
    expect((at.x - z.x) / z.k).toBeCloseTo(c.x, 6);
    expect((at.y - z.y) / z.k).toBeCloseTo(c.y, 6);
    expect(zoomAbout(t, 99, at).k).toBe(MAX_K);
    expect(zoomAbout(t, 0.001, at).k).toBe(MIN_K);
  });

  it('27. CONTROL: fitTransform centres a small diagram at 1, scales a wide one, and anchors top-left when the clamp wins', () => {
    const view = { w: 1000, h: 600 };
    expect(fitTransform({ w: 400, h: 200 }, view)).toEqual({ k: 1, x: 300, y: 200 });
    const wide = fitTransform({ w: 2000, h: 500 }, view);
    expect(wide.k).toBeCloseTo(0.492, 6);
    expect(wide.x).toBeCloseTo(8, 6);
    expect(wide.y).toBeCloseTo((600 - 500 * 0.492) / 2, 6);
    const huge = fitTransform({ w: 10000, h: 100 }, view);
    expect(huge.k).toBe(MIN_K);
    expect(huge.x).toBe(8);
  });
});

/** RCB-175. Systems of six kinds in four layers; a worker <-> queue pair (both directions), a
 * one-env edge (dashed under "both"), a planned edge and a blocked edge — so all four arrowhead
 * styles are on screen at once — and one system whose id (41 chars) and name (67) cannot fit a
 * 170 px box. */
const LEGIBLE_ID = 'an-extraordinarily-long-service-identifier';
const LEGIBLE_NAME = 'A very long descriptive system name that cannot possibly fit in a box';
const LEGIBLE_YML = `environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: ${LEGIBLE_ID}
    name: ${LEGIBLE_NAME}
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: jobs-worker
    name: jobs worker
    kind: worker
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: jobs-queue
    name: jobs queue
    kind: queue
    layer: data
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: bucket
    name: uploads bucket
    kind: storage
    layer: data
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: cache
    name: hot cache
    kind: cache
    layer: data
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: postgres
    name: primary database
    kind: db
    layer: data
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: vendor
    name: third party API
    kind: external
    layer: external
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: jobs-worker
    to: jobs-queue
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: jobs-queue
    to: jobs-worker
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: ${LEGIBLE_ID}
    to: postgres
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: jobs-worker
    to: vendor
    env: [dev, prod]
    status: planned
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: cache
    to: vendor
    env: [dev, prod]
    status: blocked
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
const LEGIBLE = () => parsedDoc(LEGIBLE_YML);

function openLegible(): void {
  openFlow({ doc: LEGIBLE(), errors: [], exists: true });
}

/** The `points` attribute of an edge's polyline, as numbers. */
function edgePoints(id: string): { x: number; y: number }[] {
  return (edgeEl(id).getAttribute('points') ?? '').split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x: x ?? Number.NaN, y: y ?? Number.NaN };
  });
}

/** core's abstract layout units to the view's pixels (LABEL_W 88 + PAD 20 across; PAD 20 down;
 * a box is 170 x 64) — written out here, not imported, so the test is not the code under test. */
function layoutPx(p: { x: number; y: number }): { x: number; y: number } {
  return { x: 88 + p.x * 170 + 20, y: p.y * 64 + 20 };
}

/** `layoutPx`, rounded the way the view rounds what it draws (to 0.01 px). */
function drawnAt(p: { x: number; y: number }): { x: number; y: number } {
  const q = layoutPx(p);
  return { x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 };
}

function legendKinds(): string[] {
  return [...screen.getByTestId('flow-legend').querySelectorAll('[data-legend-kind]')].map(
    (li) => li.getAttribute('data-legend-kind') ?? '',
  );
}

describe('Flow view legibility (RCB-175)', () => {
  it('28. every edge ends in an arrowhead: one marker per style, and each edge references the marker of ITS style', () => {
    openLegible();
    const svg = screen.getByTestId('flow-svg');
    const markers = [...svg.querySelectorAll('defs > marker')];
    expect(
      markers.map((m) => [...m.classList].filter((c) => c.startsWith('flow-arrow--'))),
    ).toEqual([
      ['flow-arrow--live'],
      ['flow-arrow--dashed'],
      ['flow-arrow--planned'],
      ['flow-arrow--blocked'],
    ]);
    const ids = markers.map((m) => m.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => /^[A-Za-z][\w-]*$/.test(id))).toBe(true);

    const edges = [...svg.querySelectorAll('polyline')];
    expect(edges).toHaveLength(5);
    const used = new Set<string>();
    for (const edge of edges) {
      const ref = /^url\(#(.+)\)$/.exec(edge.getAttribute('marker-end') ?? '');
      expect(ref, `${edge.getAttribute('data-edge')} has a marker-end`).not.toBeNull();
      const marker = document.getElementById(ref?.[1] ?? '');
      expect(marker?.tagName.toLowerCase()).toBe('marker');
      const status = edge.getAttribute('data-status');
      const style = status ?? (edge.getAttribute('data-dashed') === 'true' ? 'dashed' : 'live');
      expect(marker?.classList.contains(`flow-arrow--${style}`)).toBe(true);
      used.add(style);
    }
    // Not vacuous: the fixture really does draw all four styles.
    expect([...used].sort()).toEqual(['blocked', 'dashed', 'live', 'planned']);
  });

  it('29. two Flow views mounted at once do not share a marker id', () => {
    openLegible();
    openLegible();
    const [a, b] = screen.getAllByTestId('flow-svg');
    const idsOf = (svg: Element | undefined) =>
      [...(svg?.querySelectorAll('marker') ?? [])].map((m) => m.id);
    expect(idsOf(a)).toHaveLength(4);
    expect(idsOf(b)).toHaveLength(4);
    expect(idsOf(a).filter((id) => idsOf(b).includes(id))).toEqual([]);
    // ...and each view's edges point at ITS OWN markers.
    const own = idsOf(b);
    for (const edge of b?.querySelectorAll('polyline') ?? []) {
      expect(own.some((id) => edge.getAttribute('marker-end') === `url(#${id})`)).toBe(true);
    }
  });

  it('30. every box carries its kind: a glyph in the top-right (data-glyph), the kind name, and a family class', () => {
    openLegible();
    const expected: Record<string, [string, string]> = {
      postgres: ['cylinder', 'data'],
      bucket: ['cylinder', 'data'],
      'jobs-queue': ['bars', 'data'],
      cache: ['bolt', 'data'],
      'jobs-worker': ['cog', 'compute'],
      [LEGIBLE_ID]: ['square', 'compute'],
      vendor: ['cloud', 'external'],
    };
    for (const [id, [glyph, family]] of Object.entries(expected)) {
      const box = boxEl(id);
      const glyphs = box.querySelectorAll('[data-glyph]');
      expect(glyphs, `${id} has exactly one glyph`).toHaveLength(1);
      expect(glyphs[0]?.getAttribute('data-glyph')).toBe(glyph);
      expect(glyphs[0]?.classList.contains(`flow-fam--${family}`)).toBe(true);
      const kindText = box.querySelector('.flow-box__kind');
      expect(kindText?.textContent).toBe(box.getAttribute('data-kind'));
      expect(kindText?.classList.contains(`flow-fam--${family}`)).toBe(true);
      // Top-right: the glyph's 14 px square is inside the box, 8 px from its right edge, 6 down.
      const rect = box.querySelector('rect');
      const at = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(
        glyphs[0]?.getAttribute('transform') ?? '',
      );
      expect(Number(at?.[1])).toBe(Number(rect?.getAttribute('x')) + 170 - 8 - 14);
      expect(Number(at?.[2])).toBe(Number(rect?.getAttribute('y')) + 6);
    }
    expect(boxEl('postgres').querySelector('.flow-box__kind')?.textContent).toBe('db');
    // The tables cover every kind core knows (a new kind is a type error too), and use the four
    // families the legend and CSS tokens are written for.
    expect(Object.keys(KIND_META).sort()).toEqual([...SYSTEM_KINDS].sort());
    expect(new Set(Object.values(KIND_META).map((m) => m.family))).toEqual(
      new Set(['data', 'compute', 'external', 'ops']),
    );
    expect(KIND_META.db.glyph).toBe('cylinder');
    expect(KIND_META.storage.glyph).toBe('cylinder');
  });

  it('31. a long id and name are clipped to the box with an ellipsis, the full text is in the box <title>', () => {
    openLegible();
    const box = boxEl(LEGIBLE_ID);
    const id = box.querySelector('.flow-box__id')?.textContent ?? '';
    const name = box.querySelector('.flow-box__name')?.textContent ?? '';
    expect(id.endsWith('…')).toBe(true);
    expect(id.length).toBeLessThan(LEGIBLE_ID.length);
    expect(LEGIBLE_ID.startsWith(id.slice(0, -1))).toBe(true);
    // The id is 12 px monospace (0.6 em = 7.2 px a character) in a 170 px box less 8 + 8 padding
    // and the 20 px glyph corner: 134 px. It uses most of that room and never more.
    expect(id.length * 7.2).toBeLessThanOrEqual(134);
    expect(id.length * 7.2).toBeGreaterThan(134 - 2 * 7.2);
    expect(name.endsWith('…')).toBe(true);
    expect(LEGIBLE_NAME.startsWith(name.slice(0, -1))).toBe(true);
    expect(name.length).toBeLessThan(LEGIBLE_NAME.length);
    expect(box.querySelector('title')?.textContent).toBe(`${LEGIBLE_ID} — ${LEGIBLE_NAME}`);

    // A box that fits is left alone (and still has its <title>).
    const short = boxEl('jobs-worker');
    expect(short.querySelector('.flow-box__id')?.textContent).toBe('jobs-worker');
    expect(short.querySelector('.flow-box__name')?.textContent).toBe('jobs worker');
    expect(short.querySelector('title')?.textContent).toBe('jobs-worker — jobs worker');
  });

  it('32. CONTROL: fitText leaves what fits, and clips to the longest prefix that fits with the ellipsis', () => {
    // Monospace 12 px = 7.2 px a character: 18 chars = 129.6 <= 134, 19 = 136.8 > 134.
    expect(fitText('a'.repeat(18), 12, true, 134)).toBe('a'.repeat(18));
    // 19 clips to 17 + '…' (17 x 7.2 + 7.2 = 129.6 <= 134; 18 x 7.2 + 7.2 = 136.8 > 134).
    expect(fitText('a'.repeat(19), 12, true, 134)).toBe(`${'a'.repeat(17)}…`);
    // Proportional 11 px: 'a' is 0.56 em = 6.16 px; 23 x 6.16 + 11 = 152.7 <= 154, 24 x 6.16 + 11 > 154.
    expect(fitText('a'.repeat(50), 11, false, 154)).toBe(`${'a'.repeat(23)}…`);
    expect(fitText('', 11, false, 154)).toBe('');
    // Nothing fits: the ellipsis alone, never a throw or an empty string that hides the box.
    expect(fitText('abcdef', 12, true, 3)).toBe('…');
    // Capitals and M/W are wider than lower case, so a run of them clips sooner.
    expect(fitText('W'.repeat(30), 11, false, 154).length).toBeLessThan(
      fitText('a'.repeat(30), 11, false, 154).length,
    );
  });

  it('33. the legend is collapsed, opens from the toolbar, and lists only the kinds on this map', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    expect(screen.queryByTestId('flow-legend')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Legend' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const legend = screen.getByTestId('flow-legend');
    expect(toggle.getAttribute('aria-controls')).toBe(legend.id);
    // TWO_ENV has client, worker, service, job, db, email — listed in core's kind order — and
    // none of queue/cache/storage/auth/ci/external/tool.
    expect(legendKinds()).toEqual(['client', 'service', 'worker', 'job', 'db', 'email']);
    expect(within(legend).queryByText('queue')).toBeNull();
    // Each row draws its own glyph, in its family colour.
    const dbRow = legend.querySelector('[data-legend-kind="db"]');
    expect(dbRow?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('cylinder');
    expect(dbRow?.classList.contains('flow-fam--data')).toBe(true);

    // "on this map" follows what is on show: prod has no sendgrid (dev-only), dev no worker-jobs.
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(legendKinds()).toEqual(['client', 'service', 'worker', 'job', 'db']);
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    expect(legendKinds()).toEqual(['client', 'service', 'worker', 'db', 'email']);

    fireEvent.click(toggle);
    expect(screen.queryByTestId('flow-legend')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('34. a two-way connection is two separate lines, each exactly where core routed it (no web-side shift), both with an arrowhead', () => {
    openLegible();
    const layout = layoutSystems(LEGIBLE(), 'both');
    const route = (from: string, to: string) =>
      (layout.edges.find((e) => e.from === from && e.to === to)?.points ?? []).map(drawnAt);
    const down = edgePoints('jobs-worker-jobs-queue');
    const up = edgePoints('jobs-queue-jobs-worker');
    // Core gives each direction its own ports (RCB-179), so the two routes already differ...
    expect(route('jobs-worker', 'jobs-queue')).toHaveLength(4);
    expect(route('jobs-queue', 'jobs-worker')).toHaveLength(4);
    expect(route('jobs-worker', 'jobs-queue')).not.toEqual(route('jobs-queue', 'jobs-worker'));
    // ...and the view draws each one exactly there: not on the other's points, not a pixel moved.
    expect(down).toEqual(route('jobs-worker', 'jobs-queue'));
    expect(up).toEqual(route('jobs-queue', 'jobs-worker'));
    expect(down.some((p) => up.some((q) => q.x === p.x && q.y === p.y))).toBe(false);
    // Both stay orthogonal: every segment is horizontal or vertical.
    for (const pts of [down, up]) {
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i]?.x === pts[i - 1]?.x || pts[i]?.y === pts[i - 1]?.y).toBe(true);
      }
    }
    for (const id of ['jobs-worker-jobs-queue', 'jobs-queue-jobs-worker']) {
      expect(edgeEl(id).getAttribute('data-two-way')).toBe('true');
      expect(edgeEl(id).getAttribute('marker-end')).toMatch(/^url\(#.+\)$/);
    }
    // A one-way edge is not a two-way one, and is drawn at core's points too.
    const single = `${LEGIBLE_ID}-postgres`;
    expect(edgeEl(single).getAttribute('data-two-way')).toBeNull();
    expect(edgePoints(single)).toEqual(route(LEGIBLE_ID, 'postgres'));
    // CONTROL: shift either line sideways in Flow.tsx (add 4 px to the drawn x) and the two
    // `toEqual`s fail; route both directions over the same ports in core and `not.toEqual` fails.
  });

  it("35. every edge is drawn at core's own points, and no two drawn lines share a vertex", () => {
    openLegible();
    const layout = layoutSystems(LEGIBLE(), 'both');
    const lines = [...screen.getByTestId('flow-svg').querySelectorAll('polyline')];
    expect(lines).toHaveLength(layout.edges.length);
    const seen = new Set<string>();
    for (const [i, edge] of layout.edges.entries()) {
      const expected = edge.points.map(drawnAt).map((p) => `${p.x},${p.y}`);
      expect(lines[i]?.getAttribute('points')).toBe(expected.join(' '));
      expect(lines[i]?.getAttribute('data-edge')).toBe(`${edge.from}-${edge.to}`);
      for (const v of expected) {
        expect(seen.has(v)).toBe(false);
        seen.add(v);
      }
    }
    // Five edges, one of them (jobs-worker -> vendor) two rows long: 6 points, the others 4.
    expect(layout.edges.map((e) => e.points.length).sort()).toEqual([4, 4, 4, 4, 6]);
    // CONTROL: any shift or smoothing of `drawn` in Flow.tsx fails the `points` comparison; two
    // routes through one point (core sharing a port or a lane) fail the `seen` check.
  });

  it('36. the environments note shows under the env switch: the env on show, both when they differ, nothing for a none/absent one', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    const line = () => screen.queryByTestId('flow-envnote')?.textContent ?? null;
    expect(line()).toBe(
      'dev: vite dev :5173 + wrangler dev :8700 + local postgres :5499 · prod: Cloudflare Workers; Neon via Hyperdrive',
    );
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(line()).toBe('Cloudflare Workers; Neon via Hyperdrive');
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    expect(line()).toBe('vite dev :5173 + wrangler dev :8700 + local postgres :5499');
    // Muted, one line: the element carries the class the CSS truncates on, and the full text as a title.
    expect(screen.getByTestId('flow-envnote').classList.contains('muted')).toBe(true);
    expect(screen.getByTestId('flow-envnote').getAttribute('title')).toBe(line());
  });

  it('37. CONTROL: a `none` env has no note line (its reason is the canvas); the other env still does', () => {
    openFlow({ doc: NONE_PROD(), errors: [], exists: true });
    expect(screen.getByTestId('flow-envnote').textContent).toBe('dev: local dev only');
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    // The none note is printed once, as the prose; not repeated under the switch.
    expect(screen.queryByTestId('flow-envnote')).toBeNull();
    expect(screen.getAllByText('local-only by design — speed and tokens')).toHaveLength(1);
  });

  it('38. CONTROL: envNoteLine — equal notes once, a null or blank note is absent, both null is null', () => {
    expect(envNoteLine({ dev: 'same', prod: 'same' }, 'both')).toBe('same');
    expect(envNoteLine({ dev: 'a', prod: 'b' }, 'both')).toBe('dev: a · prod: b');
    expect(envNoteLine({ dev: null, prod: 'b' }, 'both')).toBe('prod: b');
    expect(envNoteLine({ dev: 'a', prod: null }, 'both')).toBe('dev: a');
    expect(envNoteLine({ dev: null, prod: null }, 'both')).toBeNull();
    expect(envNoteLine({ dev: '  ', prod: 'b' }, 'dev')).toBeNull();
    expect(envNoteLine({ dev: 'a', prod: null }, 'prod')).toBeNull();
    expect(envNoteLine({ dev: 'a', prod: 'b' }, 'prod')).toBe('b');
  });

  it('39. rows sit on bands: one per layer in row order, every other one tinted, tiling the diagram, row labels kept', () => {
    openLegible();
    const svg = screen.getByTestId('flow-svg');
    const bands = [...svg.querySelectorAll('path[data-band]')];
    // app, data, external (no client/edge/ops systems in this fixture).
    expect(bands.map((b) => b.getAttribute('data-band'))).toEqual(['app', 'data', 'external']);
    expect(bands.map((b) => b.classList.contains('flow-band--alt'))).toEqual([false, true, false]);
    const layout = layoutSystems(LEGIBLE(), 'both');
    const content = flowContentSize(layout);
    const span = bands.map((b) => {
      const m = /^M0 ([\d.]+) H([\d.]+) V([\d.]+) H0 Z$/.exec(b.getAttribute('d') ?? '');
      return { top: Number(m?.[1]), w: Number(m?.[2]), bottom: Number(m?.[3]) };
    });
    // Full width of the diagram; the first starts at the top; each starts where the last ended
    // (rows are 128 px apart and a band is 128 px); none runs past the diagram's bottom.
    expect(span.map((b) => b.w)).toEqual([content.w, content.w, content.w]);
    expect(span[0]?.top).toBe(0);
    expect(span[1]?.top).toBe(span[0]?.bottom);
    expect(span[2]?.top).toBe(span[1]?.bottom);
    expect((span[1]?.bottom ?? 0) - (span[1]?.top ?? 0)).toBe(128);
    expect(span[2]?.bottom).toBeLessThanOrEqual(content.h);
    // Each row's boxes lie inside its own band.
    for (const [i, row] of layout.rows.entries()) {
      for (const box of row.boxes) {
        const rect = boxEl(box.id).querySelector('rect');
        const y = Number(rect?.getAttribute('y'));
        expect(y).toBeGreaterThanOrEqual(span[i]?.top ?? Number.POSITIVE_INFINITY);
        expect(y + 64).toBeLessThanOrEqual(span[i]?.bottom ?? 0);
      }
    }
    expect([...svg.querySelectorAll('.flow-row-label')].map((t) => t.textContent)).toEqual([
      'app',
      'data',
      'external',
    ]);
  });

  it('40. RCB-192: a row gap that grew with its tracks keeps the bands tiling: first top 0, each top the last bottom, the last bottom the diagram bottom, each holding its boxes', () => {
    // Ten client boxes, ten app boxes, box i of the top row to box 9 - i of the bottom row: every
    // pair crosses, which is 11 tracks in the one gap, so core makes it 0.125 * 12 = 1.5 units
    // tall (measured: the app row sits at y 2.5, not 2).
    const ids = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i));
    const system = (id: string, layer: string) => `  - id: ${id}
    name: ${id}
    kind: service
    layer: ${layer}
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
    const link = (from: string, to: string) => `  - from: ${from}
    to: ${to}
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
    const doc = parsedDoc(`environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
${ids.map((c) => system(`t${c}`, 'client')).join('')}${ids.map((c) => system(`u${c}`, 'app')).join('')}connections:
${ids.map((c, i) => link(`t${c}`, `u${ids[9 - i]}`)).join('')}`);
    const layout = layoutSystems(doc, 'both');
    expect(layout.rows.map((r) => r.boxes[0]?.y)).toEqual([0, 2.5]);
    openFlow({ doc, errors: [], exists: true });
    const svg = screen.getByTestId('flow-svg');
    const bands = [...svg.querySelectorAll('path[data-band]')];
    expect(bands.map((b) => b.getAttribute('data-band'))).toEqual(['client', 'app']);
    const content = flowContentSize(layout);
    const span = bands.map((b) => {
      const m = /^M0 ([\d.]+) H([\d.]+) V([\d.]+) H0 Z$/.exec(b.getAttribute('d') ?? '');
      return { top: Number(m?.[1]), bottom: Number(m?.[3]) };
    });
    expect(span[0]?.top).toBe(0);
    expect(span[1]?.top).toBe(span[0]?.bottom);
    expect(span[1]?.bottom).toBe(content.h);
    // The boundary is midway between the client row's bottom (20 + 64 = 84 px) and the app row's
    // top (2.5 * 64 + 20 = 180 px): 132, so both bands are 132 px, not the ungrown 128.
    expect(span.map((b) => [b.top, b.bottom])).toEqual([
      [0, 132],
      [132, 264],
    ]);
    // Each row's boxes lie inside its own band.
    for (const [i, row] of layout.rows.entries()) {
      for (const box of row.boxes) {
        const y = Number(boxEl(box.id).querySelector('rect')?.getAttribute('y'));
        expect(y).toBeGreaterThanOrEqual(span[i]?.top ?? Number.POSITIVE_INFINITY);
        expect(y + 64).toBeLessThanOrEqual(span[i]?.bottom ?? 0);
      }
    }
    // CONTROL: the old band (`top = at.y - 32`, `bottom = at.y + 96`) ends the client band at 116
    // and starts the app band at 148 — a 32 px strip in no band — so `span[1].top` is not
    // `span[0].bottom` and the first `toBe` on it fails.
  });
});

// ---- RCB-176: click a connection ---------------------------------------------------------------

/** web -> api (a label, a via, pointers, hand); api -> db twice, told apart by `id` (a pair may
 * repeat only then): `reads` is dev-only, detected, with a label and no pointers; `writes` is in
 * both envs, hand, with pointers and no label. Three rows, four ways a row can differ. */
const CONN_YML = `environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: web
    name: web client
    kind: client
    layer: client
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: db
    name: primary database
    kind: db
    layer: data
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: api
    label: orders
    via: "HTTPS"
    env: [dev, prod]
    pointers: ["apps/web/api.ts"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: api
    to: db
    id: reads
    label: read replica
    via: "SQL read"
    env: [dev]
    source: { detected: "package.json", at: "2026-09-23T00:00:00Z" }
  - from: api
    to: db
    id: writes
    via: "SQL primary"
    env: [dev, prod]
    pointers: ["apps/api/db.ts"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
const CONN = () => parsedDoc(CONN_YML);

function connRef(spec: string) {
  return { spec, path: spec, start: 1, end: 1, text: 'export {};', truncated: false, error: null };
}

/** Every visible edge's hit path for `from-to`, in draw order (a pair with several rows has several). */
function hitEls(id: string): Element[] {
  return [...screen.getByTestId('flow-svg').querySelectorAll(`[data-edge-hit="${id}"]`)];
}
function hitEl(id: string, k = 0): Element {
  const el = hitEls(id)[k];
  if (!el) throw new Error(`no hit path #${k} for ${id}`);
  return el;
}
function edgeEls(id: string): Element[] {
  return [...screen.getByTestId('flow-svg').querySelectorAll(`[data-edge="${id}"]`)];
}
function connDrawer(): HTMLElement {
  return screen.getByTestId('flow-conn-drawer');
}

/** `pts` (px) half way along by LENGTH — written out here, not imported, so the test is not the
 * code under test. */
function halfway(pts: { x: number; y: number }[]): { x: number; y: number } {
  const segs = pts.slice(1).map((b, i) => {
    const a = pts[i] as { x: number; y: number };
    return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  let left = segs.reduce((sum, s2) => sum + s2.len, 0) / 2;
  for (const seg of segs) {
    if (left <= seg.len) {
      const f = seg.len === 0 ? 0 : left / seg.len;
      return { x: seg.a.x + (seg.b.x - seg.a.x) * f, y: seg.a.y + (seg.b.y - seg.a.y) * f };
    }
    left -= seg.len;
  }
  return pts[0] ?? { x: 0, y: 0 };
}

/** The page at `url` (a path + search, as the address bar would hold it): the store is made AFTER
 * the address bar is set, exactly as on a reload, and is not told which view to open. */
function openFlowAt(
  url: string,
  systems: { doc: SystemsDoc | null; errors: string[]; exists: boolean },
) {
  window.history.replaceState(null, '', url);
  const store = testStore();
  store.dispatch({
    type: 'snapshot',
    board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')], hasBoard: true },
    repo: null,
    systems,
  });
  renderApp(store);
  return { store };
}

/** Every connection's pointers resolve to one line — for the tests that click a row with pointers
 * but are about something else. (A test that asserts on fetches makes its own `stubFetch`.) */
function stubConnRefs() {
  return stubFetch({
    '/api/systems/connections/web/api/refs': [connRef('apps/web/api.ts')],
    '/api/systems/connections/api/db/refs?id=writes': [connRef('apps/api/db.ts')],
  });
}
/** One turn of the microtask queue, inside `act`: lets a resolved fetch land before the test ends. */
async function settle(): Promise<void> {
  await act(async () => {});
}

describe('Flow view: click a connection (RCB-176)', () => {
  beforeEach(() => {
    stubConnRefs();
  });

  it("40. clicking an edge opens the connection drawer with the row's fields, and its pointers come from the connection route", async () => {
    const fetchMock = stubFetch({
      '/api/systems/connections/web/api/refs': [connRef('apps/web/api.ts')],
      '/api/systems/connections/api/db/refs?id=writes': [connRef('apps/api/db.ts')],
      '/api/git': { root: '/work/repo', web: null, head: null },
    });
    openFlow({ doc: CONN(), errors: [], exists: true });
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();

    fireEvent.click(hitEl('web-api'));
    const drawer = connDrawer();
    // One drawer at a time: the connection's, not a system's.
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    expect(within(drawer).getByText('orders')).toBeInTheDocument(); // label
    expect(within(drawer).getByText('HTTPS')).toBeInTheDocument(); // via
    expect(within(drawer).getByText('dev+prod')).toBeInTheDocument(); // env
    expect(within(drawer).getByText('live')).toBeInTheDocument(); // status
    expect(drawer).toHaveTextContent('hand: owner · 2026-09-22T00:00:00Z'); // source
    // A live row with nothing recorded against it has no "Unblocked by" section.
    expect(within(drawer).queryByTestId('flow-conn-unblockers')).toBeNull();

    // Its pointers resolve live, through the CONNECTION route (no ?id= on a row with no id).
    const refs = await within(drawer).findByTestId('flow-conn-refs');
    await within(refs).findByText(/1 lines/);
    expect(refs).toHaveTextContent('apps/web/api.ts:1');
    // The refs route and (RCB-178) `/api/git` for the links: one fetch each.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/systems/connections/web/api/refs');

    // The row with an id says so, in the bar, and asks for it: `?id=`.
    fireEvent.click(hitEl('api-db', 1));
    expect(within(connDrawer()).getByText('SQL primary')).toBeInTheDocument();
    expect(connDrawer()).toHaveTextContent('connection · writes');
    await within(connDrawer()).findByText(/1 lines/);
    expect(fetchMock).toHaveBeenCalledWith('/api/systems/connections/api/db/refs?id=writes');
    // CONTROL: without the hit path, nothing here can be clicked (fireEvent throws on the missing
    // element in `hitEl`); without `useConnectionRefs` the two `toHaveBeenCalledWith`s fail;
    // dropping `?id=` fails the second; dropping the `flow-conn-drawer` branch fails line 1.
  });

  it('41. a connection with no pointers fetches nothing and has no Pointers section; a non-live one lists its unblockers', async () => {
    const fetchMock = stubFetch({});
    openFlow({ doc: CONN(), errors: [], exists: true });
    fireEvent.click(hitEl('api-db', 0)); // `reads`: detected, dev-only, no pointers
    const drawer = connDrawer();
    expect(within(drawer).getByText('SQL read')).toBeInTheDocument();
    expect(within(drawer).getByText('read replica')).toBeInTheDocument();
    expect(within(drawer).getByText('dev')).toBeInTheDocument();
    expect(drawer).toHaveTextContent('detected: package.json · 2026-09-23T00:00:00Z');
    expect(within(drawer).queryByTestId('flow-conn-refs')).toBeNull();
    // (an effect that ran would have called fetch by now; flush one microtask turn to be sure)
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    // CONTROL: fetching unconditionally (no `url === null` in useRefsAt) calls the stub, which
    // throws on the unlisted URL -> `toHaveBeenCalled` fails here.
  });

  it('42. a blocked connection shows its status and its unblocked_by rows, each a card button', () => {
    const doc = parsedDoc(`environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: web
    name: web client
    kind: client
    layer: client
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: svc
    name: service
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: svc
    env: [dev, prod]
    status: blocked
    unblocked_by: ["RB-1"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`);
    const { store } = openFlow({ doc, errors: [], exists: true }, statusCards());
    fireEvent.click(hitEl('web-svc'));
    const drawer = connDrawer();
    expect(within(drawer).getByText('blocked')).toBeInTheDocument();
    // No label, no via: a dash, never an empty string.
    expect(within(drawer).getAllByText('—')).toHaveLength(2);
    const section = within(drawer).getByTestId('flow-conn-unblockers');
    expect(within(section).getByText('Unblocked by (1)')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'RB-1 — Pick a path [decide]' }));
    expect(store.getState().selectedId).toBe('RB-1');
    expect(store.getState().view).toBe('board');
    // CONTROL: without the `flow-conn-unblockers` section (or its UnblockerRows) this fails at the
    // first `within(drawer)` lookup; without the status field, at `getByText('blocked')`.
  });

  it("43. the from and to buttons switch to that system's drawer (one selection at a time)", async () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    fireEvent.click(hitEl('web-api'));
    const ends = within(connDrawer()).getByTestId('flow-conn-ends');
    expect(
      within(ends)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['web', 'api']);

    fireEvent.click(within(ends).getByRole('button', { name: 'web' }));
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();
    expect(within(screen.getByTestId('flow-drawer')).getByText('web client')).toBeInTheDocument();

    // ...and back, then the other end.
    fireEvent.click(hitEl('web-api'));
    fireEvent.click(
      within(within(connDrawer()).getByTestId('flow-conn-ends')).getByRole('button', {
        name: 'api',
      }),
    );
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();
    expect(within(screen.getByTestId('flow-drawer')).getByText('api service')).toBeInTheDocument();
    // Opening the system focuses its box, as clicking the box does (web -> api -> db: db is a
    // neighbour of api, so nothing is dimmed).
    expect(dimmedBoxes()).toEqual([]);
    await settle();
    // CONTROL: a from/to that is not a button (or a button that does not call onSelectSystem)
    // fails the `getAllByRole('button')` / the first `queryByTestId('flow-conn-drawer')`.
  });

  it("44. the system drawer's connection rows: the other end is a button that opens that system, and each row opens its connection", async () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    fireEvent.click(boxEl('api'));
    const drawer = screen.getByTestId('flow-drawer');
    expect(within(drawer).getByText('Connections (3)')).toBeInTheDocument();
    // The system itself stays bold text; only the OTHER end is a button.
    expect(within(drawer).getAllByText('api', { selector: 'strong' })).toHaveLength(3);
    const pair = drawer.querySelectorAll('li[data-connection="api-db"]');
    expect(pair).toHaveLength(2);

    // A row opens its connection — the one with THAT id.
    fireEvent.click(within(drawer).getByRole('button', { name: 'open connection · writes' }));
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    expect(within(connDrawer()).getByText('SQL primary')).toBeInTheDocument();

    // Back to the system, then a row with no id, and the other end.
    fireEvent.click(
      within(within(connDrawer()).getByTestId('flow-conn-ends')).getByRole('button', {
        name: 'api',
      }),
    );
    const again = screen.getByTestId('flow-drawer');
    fireEvent.click(within(again).getByRole('button', { name: 'open connection' }));
    expect(within(connDrawer()).getByText('orders')).toBeInTheDocument();

    fireEvent.click(
      within(within(connDrawer()).getByTestId('flow-conn-ends')).getByRole('button', {
        name: 'api',
      }),
    );
    fireEvent.click(
      within(screen.getByTestId('flow-drawer')).getAllByRole('button', {
        name: 'db',
      })[0] as Element,
    );
    const dbDrawer = screen.getByTestId('flow-drawer');
    expect(within(dbDrawer).getByText('primary database')).toBeInTheDocument();
    await settle();
    // CONTROL: plain-text ends fail the `name: 'db'` lookup; no row button fails the first
    // `name: 'open connection · writes'`; a row button that opens the pair's first row instead of
    // its own fails the same test at `SQL primary`.
  });

  it('45. an edge has a wide hit path over the same route, after the visible line; hover lights the line, and only that one', () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    const svg = screen.getByTestId('flow-svg');
    const hits = [...svg.querySelectorAll('[data-edge-hit]')];
    expect(hits).toHaveLength(3);
    expect(EDGE_HIT_W).toBeGreaterThanOrEqual(12);
    for (const hit of hits) {
      expect(Number(hit.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(12);
      // Drawn right AFTER its visible line (so it is on top), and along exactly its points.
      const line = hit.previousElementSibling;
      expect(line?.tagName.toLowerCase()).toBe('polyline');
      expect(line?.getAttribute('data-edge')).toBe(hit.getAttribute('data-edge-hit'));
      expect(hit.getAttribute('d')).toBe(
        `M${(line?.getAttribute('points') ?? '').split(' ').join(' L')}`,
      );
      // Hover state is a class on the visible line.
      expect(line?.classList.contains('flow-edge--hover')).toBe(false);
    }
    const target = hitEl('web-api');
    fireEvent.mouseEnter(target);
    expect(edgeEl('web-api').classList.contains('flow-edge--hover')).toBe(true);
    expect(svg.querySelectorAll('.flow-edge--hover')).toHaveLength(1);
    fireEvent.mouseLeave(target);
    expect(svg.querySelectorAll('.flow-edge--hover')).toHaveLength(0);
    // The hit path is not one of the diagram's `polyline`s: their count is still the row count.
    expect(svg.querySelectorAll('polyline')).toHaveLength(3);
    // CONTROL: no onMouseEnter fails at the first `flow-edge--hover` expectation; a hit path drawn
    // BEFORE its line fails `previousElementSibling`; stroke-width < 12 fails the >= 12 checks.
  });

  it("46. the selected edge is drawn selected: the row's own edge among parallel ones, none once closed", async () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    const svg = screen.getByTestId('flow-svg');
    const selectedEdges = () =>
      [...svg.querySelectorAll('.flow-edge--selected')].map((e) => e.getAttribute('data-edge'));
    expect(selectedEdges()).toEqual([]);
    fireEvent.click(hitEl('api-db', 1)); // `writes`, the SECOND api -> db row
    expect(selectedEdges()).toEqual(['api-db']);
    expect(edgeEls('api-db')[1]?.classList.contains('flow-edge--selected')).toBe(true);
    expect(edgeEls('api-db')[0]?.classList.contains('flow-edge--selected')).toBe(false);
    fireEvent.click(hitEl('api-db', 0));
    expect(edgeEls('api-db')[0]?.classList.contains('flow-edge--selected')).toBe(true);
    expect(edgeEls('api-db')[1]?.classList.contains('flow-edge--selected')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(selectedEdges()).toEqual([]);
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();
    // Selecting a box lets go of a connection (and the other way round).
    fireEvent.click(hitEl('web-api'));
    fireEvent.click(boxEl('web'));
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();
    expect(selectedEdges()).toEqual([]);
    await settle();
    // CONTROL: matching by (from,to) only (no ordinal) selects the first api-db edge for `writes`
    // and fails the `[1]` expectation; no `flow-edge--selected` fails the first one.
  });

  it("47. a label is drawn at the route's midpoint (by length), with the row it belongs to; via is never drawn", () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    const svg = screen.getByTestId('flow-svg');
    const layout = layoutSystems(CONN(), 'both');
    const edge = layout.edges.find((e) => e.from === 'web' && e.to === 'api');
    const expected = halfway((edge?.points ?? []).map(layoutPx));
    const label = svg.querySelector('[data-edge-label="web-api"]');
    expect(label?.textContent).toBe('orders');
    expect(Number(label?.getAttribute('x'))).toBeCloseTo(expected.x, 1);
    expect(Number(label?.getAttribute('y'))).toBeCloseTo(expected.y, 1);
    expect(label?.classList.contains('flow-edge__label')).toBe(true);
    // Labelled rows draw one; the unlabelled `writes` row draws none.
    expect([...svg.querySelectorAll('[data-edge-label]')].map((t) => t.textContent)).toEqual([
      'orders',
      'read replica',
    ]);
    // `via` is a drawer field only: no <text> and no <title> in the diagram carries it.
    for (const via of ['HTTPS', 'SQL read', 'SQL primary']) {
      expect(svg.textContent).not.toContain(via);
    }
    // The label sits between the hit path and the next edge; it never takes the click itself
    // (CSS: pointer-events none), but a label click is an edge's, so no handler lives on it.
    expect(label?.previousElementSibling?.getAttribute('data-edge-hit')).toBe('web-api');
    // CONTROL: no label element fails the textContent check; a label placed at the route's first
    // point (or anywhere but its middle) fails the x/y; `via` back in the <title> fails the
    // `not.toContain`. (Length vs vertex count is told apart by test 51, not here: this route is
    // symmetric, so both give the same point.)
  });

  it('48. rows of one pair are separate routes in core and drawn apart, each exactly where core put it', () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    const layout = layoutSystems(CONN(), 'both');
    const route = layout.edges.filter((e) => e.from === 'api' && e.to === 'db');
    expect(route).toHaveLength(2);
    // core gives each row a port of its own (RCB-179) — before, it routed both identically and
    // the view had to spread them.
    expect(route[0]?.points).not.toEqual(route[1]?.points);
    const drawn = edgeEls('api-db').map((e) => e.getAttribute('points'));
    expect(drawn).toEqual(
      route.map((e) =>
        e.points
          .map(drawnAt)
          .map((p) => `${p.x},${p.y}`)
          .join(' '),
      ),
    );
    // One third of a box apart (two ports on each end of a 170 px side: 1/3 and 2/3).
    const xs = drawn.map((points) => Number((points ?? '').split(',')[0]));
    expect(Math.abs((xs[0] ?? 0) - (xs[1] ?? 0))).toBeCloseTo(170 / 3, 1);
    // A lone edge runs exactly where the layout puts it (web -> api: one port each end).
    const web = drawnAt(layout.edges.find((e) => e.from === 'web')?.points[0] ?? { x: 0, y: 0 });
    expect((edgeEl('web-api').getAttribute('points') ?? '').split(' ')[0]).toBe(
      `${web.x},${web.y}`,
    );
    // CONTROL: put both rows on one port in core (`x + w / 2` for every port) and `not.toEqual`
    // fails; add a spread in Flow.tsx and `drawn` no longer equals core's points.
  });

  it('49. env: `prod` hides the dev-only row, and the edge left is the row that belongs to it (writes, not reads)', async () => {
    openFlow({ doc: CONN(), errors: [], exists: true });
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(hitEls('api-db')).toHaveLength(1);
    expect(screen.getByTestId('flow-svg').querySelector('[data-edge-label="api-db"]')).toBeNull();
    fireEvent.click(hitEl('api-db'));
    expect(within(connDrawer()).getByText('SQL primary')).toBeInTheDocument();
    expect(connDrawer()).toHaveTextContent('connection · writes');
    await settle();
    // CONTROL: mapping edge k to row k of the WHOLE doc (ignoring env) shows `reads` here.
  });

  it('50. CONTROL: connectionsForEdges — the k-th edge of a pair is the k-th row visible in that env; findConnection needs an id for a repeated pair', () => {
    const doc = CONN();
    const both = layoutSystems(doc, 'both');
    expect(connectionsForEdges(doc, both).map((c) => c?.id ?? c?.label)).toEqual([
      'orders',
      'reads',
      'writes',
    ]);
    const prod = layoutSystems(doc, 'prod');
    expect(connectionsForEdges(doc, prod).map((c) => c?.id ?? c?.label)).toEqual([
      'orders',
      'writes',
    ]);
    // Rows are the doc's own objects, so the diagram can compare them by identity.
    expect(connectionsForEdges(doc, both)[2]).toBe(doc.connections[2]);

    expect(findConnection(doc, { from: 'web', to: 'api', id: null })).toBe(doc.connections[0]);
    expect(findConnection(doc, { from: 'api', to: 'db', id: 'writes' })).toBe(doc.connections[2]);
    expect(findConnection(doc, { from: 'api', to: 'db', id: null })).toBeUndefined();
    expect(findConnection(doc, { from: 'api', to: 'db', id: 'nope' })).toBeUndefined();
    expect(findConnection(doc, { from: 'db', to: 'api', id: null })).toBeUndefined();
  });

  it('51. CONTROL: polylineMidpoint walks half the LENGTH, not half the vertices', () => {
    const at = (pts: { x: number; y: number }[], x: number, y: number) => {
      const m = polylineMidpoint(pts);
      expect(m.x).toBeCloseTo(x, 6);
      expect(m.y).toBeCloseTo(y, 6);
    };
    at(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      5,
      0,
    );
    // L: 10 across then 30 down = 40; half is 20 = 10 down the second leg. (By vertex count it
    // would be the corner, (10, 0).)
    at(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 30 },
      ],
      10,
      10,
    );
    // Repeated points add nothing; a lone point is itself; nothing at all is the origin.
    at(
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
        { x: 6, y: 2 },
      ],
      4,
      2,
    );
    at([{ x: 3, y: 4 }], 3, 4);
    at([], 0, 0);
  });
});

// ---- RCB-178: "how to get there" ---------------------------------------------------------------

/** One system with pointers of every shape (a range, one line, a whole file under a directory with a
 * space in its name, and one that will not resolve) and two docs; another with neither, and only a
 * prod runtime. */
const GIT_YML = `environments:
  dev:  { note: "d" }
  prod: { note: "p" }
systems:
  - id: gateway
    name: edge gateway
    kind: worker
    layer: edge
    env: [dev, prod]
    runtime: { dev: "wrangler dev", prod: "Cloudflare Workers" }
    pointers: ["apps/gateway/src/index.ts:L10-L20", "apps/gateway/src/main.ts:L7", "docs/my notes/plan.md", "apps/gateway/missing.ts:L1"]
    docs: ["docs/BUILD-PLAN.md#§3", "docs/nope.md"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: jobs
    name: background jobs
    kind: job
    layer: app
    env: [prod]
    runtime: { prod: "queue consumer" }
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: gateway
    to: jobs
    env: [prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
const GIT_DOC = () => parsedDoc(GIT_YML);
const SHA = '0123456789abcdef0123456789abcdef01234567';
const GIT_HOME: RepoGitPayload = {
  root: '/home/demo/my repo',
  web: 'https://github.com/acme/widgets',
  head: SHA,
};
const GH = `https://github.com/acme/widgets/blob/${SHA}`;
const ED = 'vscode://file/home/demo/my%20repo';

function okRef(spec: string, path: string, start: number, end: number): ResolvedRef {
  return { spec, path, start, end, text: 'x', truncated: false, error: null };
}
function badRef(spec: string, path: string, error: string): ResolvedRef {
  return { spec, path, start: null, end: null, text: null, truncated: false, error };
}
const GATEWAY_REFS: ResolvedRef[] = [
  okRef('apps/gateway/src/index.ts:L10-L20', 'apps/gateway/src/index.ts', 10, 20),
  okRef('apps/gateway/src/main.ts:L7', 'apps/gateway/src/main.ts', 7, 7),
  okRef('docs/my notes/plan.md', 'docs/my notes/plan.md', 1, 3),
  badRef(
    'apps/gateway/missing.ts:L1',
    'apps/gateway/missing.ts',
    'not found: apps/gateway/missing.ts',
  ),
];
const GATEWAY_DOCS: ResolvedRef[] = [
  okRef('docs/BUILD-PLAN.md#§3', 'docs/BUILD-PLAN.md', 40, 52),
  badRef('docs/nope.md', 'docs/nope.md', 'not found: docs/nope.md'),
];
const GATEWAY_TESTS = {
  pointers: [],
  files: 0,
  source: 'static: test files that import or name the pointer, read live',
  line: 'tests: none found',
  measured: {
    pointers: [],
    pct: null,
    source: 'coverage: no report at coverage/coverage-summary.json',
    line: 'lines: n/a (no coverage report)',
  },
};

/** `stubFetch`, but each route is a function called per request — so a test can change an answer
 * between two opens of a drawer. */
function stubLive(byUrl: Record<string, () => unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const make = byUrl[url];
    if (make === undefined) throw new Error(`unexpected fetch: ${url}`);
    const payload = make();
    return { ok: true, status: 200, json: async () => payload, url };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
function gatewayRoutes(git: () => unknown = () => GIT_HOME): Record<string, () => unknown> {
  return {
    '/api/git': git,
    '/api/systems/gateway/refs': () => GATEWAY_REFS,
    '/api/systems/gateway/docs': () => GATEWAY_DOCS,
    '/api/systems/gateway/tests': () => GATEWAY_TESTS,
  };
}
const hrefsIn = (el: HTMLElement) =>
  within(el)
    .getAllByRole('link')
    .map((a) => a.getAttribute('href'));
const callsTo = (fetchMock: ReturnType<typeof stubLive>, url: string) =>
  fetchMock.mock.calls.filter((c) => c[0] === url).length;

describe('Flow drawers: how to get there (RCB-178)', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('178.1 a resolved pointer or doc gets an editor link and a GitHub link — range, one line, whole file — and an errored one gets neither', async () => {
    stubLive(gatewayRoutes());
    openFlow({ doc: GIT_DOC(), errors: [], exists: true });
    fireEvent.click(boxEl('gateway'));

    const refs = await screen.findByTestId('flow-drawer-refs');
    await within(refs).findAllByRole('link');
    // Three resolved pointers, two links each, in order; the fourth did not resolve and has none.
    expect(hrefsIn(refs)).toEqual([
      `${ED}/apps/gateway/src/index.ts:10`, // a range: the editor opens at its first line
      `${GH}/apps/gateway/src/index.ts#L10-L20`,
      `${ED}/apps/gateway/src/main.ts:7`, // one line
      `${GH}/apps/gateway/src/main.ts#L7`,
      `${ED}/docs/my%20notes/plan.md`, // a whole file: no `:1`, no anchor; segments encoded
      `${GH}/docs/my%20notes/plan.md`,
    ]);
    expect(
      within(refs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['editor', 'GitHub', 'editor', 'GitHub', 'editor', 'GitHub']);
    const errored = within(refs).getByTestId('ref-error');
    expect(errored).toHaveTextContent('not found: apps/gateway/missing.ts');
    expect(within(errored).queryAllByRole('link')).toHaveLength(0);

    // The docs go through the same links: a heading ref links to its resolved span.
    const docs = await screen.findByTestId('flow-drawer-docs');
    await within(docs).findAllByRole('link');
    expect(hrefsIn(docs)).toEqual([
      `${ED}/docs/BUILD-PLAN.md:40`,
      `${GH}/docs/BUILD-PLAN.md#L40-L52`,
    ]);
    expect(
      within(docs.querySelector('[data-testid="ref-error"]') as HTMLElement).queryAllByRole('link'),
    ).toHaveLength(0);
    // CONTROL: `linksFor` not passed to a RefsList leaves that section with no links (the
    // `findAllByRole` times out); a `:${r.start}` on a whole file, or an anchor on one, fails the
    // third pair; dropping `encodePath`/`encodeURIComponent` fails the `my%20notes` and `my%20repo`
    // hrefs; calling `linksFor` for an errored ref fails the `queryAllByRole('link')` lengths.
  });

  it('178.2 no GitHub link when web or head is null — the editor link stays; never a broken href', async () => {
    for (const git of [
      { ...GIT_HOME, web: null },
      { ...GIT_HOME, head: null },
    ]) {
      stubLive(gatewayRoutes(() => git));
      window.history.replaceState(null, '', '/'); // the last pass left `?view=flow&system=gateway`
      openFlow({ doc: GIT_DOC(), errors: [], exists: true });
      fireEvent.click(boxEl('gateway'));
      const refs = await screen.findByTestId('flow-drawer-refs');
      await within(refs).findAllByRole('link');
      expect(hrefsIn(refs)).toEqual([
        `${ED}/apps/gateway/src/index.ts:10`,
        `${ED}/apps/gateway/src/main.ts:7`,
        `${ED}/docs/my%20notes/plan.md`,
      ]);
      expect(screen.queryByRole('link', { name: 'GitHub' })).toBeNull();
      expect(document.body.innerHTML).not.toContain('null/blob');
      expect(document.body.innerHTML).not.toContain('/blob/null');
      cleanupFlow();
    }
    // CONTROL: dropping the `git.web === null || git.head === null` guard in `githubHref` yields
    // `null/blob/...` (web null) or `.../blob/null/...` (head null) links: the hrefs list is longer
    // and the `queryByRole('link', { name: 'GitHub' })` finds one.
  });

  it('178.3 /api/git is fetched on every open (live, never cached), and only when the drawer has something to link', async () => {
    let head = SHA;
    const fetchMock = stubLive(gatewayRoutes(() => ({ ...GIT_HOME, head })));
    openFlow({ doc: GIT_DOC(), errors: [], exists: true });
    fireEvent.click(boxEl('gateway'));
    const first = await screen.findByTestId('flow-drawer-refs');
    await within(first).findAllByRole('link');
    expect(callsTo(fetchMock, '/api/git')).toBe(1);
    expect(hrefsIn(first)[1]).toContain(`/blob/${SHA}/`);

    // The commit moves; close and reopen: a second fetch, and the new sha in the link.
    head = 'fedcba9876543210fedcba9876543210fedcba98';
    fireEvent.click(
      within(screen.getByTestId('flow-drawer')).getByRole('button', { name: 'Close' }),
    );
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    fireEvent.click(boxEl('gateway'));
    const second = await screen.findByTestId('flow-drawer-refs');
    await within(second).findAllByRole('link');
    expect(callsTo(fetchMock, '/api/git')).toBe(2);
    expect(hrefsIn(second)[1]).toContain(`/blob/${head}/`);

    // A system with no pointers and no docs has nothing to link: no git fetch, no docs fetch.
    fireEvent.click(boxEl('jobs'));
    expect(
      within(screen.getByTestId('flow-drawer')).getByRole('heading', { name: 'background jobs' }),
    ).toBeInTheDocument();
    await settle();
    expect(callsTo(fetchMock, '/api/git')).toBe(2);
    expect(fetchMock.mock.calls.map((c) => c[0]).filter((u) => u.includes('/jobs/'))).toEqual([]);
    // CONTROL: caching the answer (a module-level memo in `loadGit`) fails the `toBe(2)` and the
    // fresh-sha expectation; dropping `enabled` from `useRepoGit` fails the last two expectations.
  });

  it('178.4 both fetches follow the repo key: /api/repos/<key>/git and /systems/<id>/docs', async () => {
    const fetchMock = stubLive({
      '/api/repos/alpha/git': () => GIT_HOME,
      '/api/repos/alpha/systems/gateway/refs': () => GATEWAY_REFS,
      '/api/repos/alpha/systems/gateway/docs': () => GATEWAY_DOCS,
      '/api/repos/alpha/systems/gateway/tests': () => GATEWAY_TESTS,
    });
    const store = createStore(createMockTransport({ tick: null }), {
      repoKey: 'alpha',
      storage: { getItem: () => null, setItem: () => undefined },
    });
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')], hasBoard: true },
      repo: null,
      systems: { doc: GIT_DOC(), errors: [], exists: true },
    });
    store.setView('flow');
    renderApp(store);
    fireEvent.click(boxEl('gateway'));
    const docs = await screen.findByTestId('flow-drawer-docs');
    await within(docs).findAllByRole('link');
    expect(callsTo(fetchMock, '/api/repos/alpha/git')).toBe(1);
    expect(callsTo(fetchMock, '/api/repos/alpha/systems/gateway/docs')).toBe(1);
    expect(callsTo(fetchMock, '/api/git')).toBe(0);
    // CONTROL: an unscoped `/api/git` (no `apiPath`) is not in the routes and throws, so no link
    // ever appears and `findAllByRole` times out.
  });

  it('178.5 the connection drawer links its pointers the same way; a row with no pointers fetches no git', async () => {
    const fetchMock = stubLive({
      '/api/git': () => GIT_HOME,
      '/api/systems/connections/web/api/refs': () => [
        okRef('apps/web/api.ts:L4-L9', 'apps/web/api.ts', 4, 9),
      ],
    });
    openFlow({ doc: CONN(), errors: [], exists: true });
    fireEvent.click(hitEl('web-api'));
    const refs = await within(connDrawer()).findByTestId('flow-conn-refs');
    await within(refs).findAllByRole('link');
    expect(hrefsIn(refs)).toEqual([`${ED}/apps/web/api.ts:4`, `${GH}/apps/web/api.ts#L4-L9`]);
    expect(callsTo(fetchMock, '/api/git')).toBe(1);

    fireEvent.click(hitEl('api-db', 0)); // `reads`: no pointers
    await within(connDrawer()).findByText('read replica');
    await settle();
    expect(callsTo(fetchMock, '/api/git')).toBe(1);
    // CONTROL: no `linksFor` on the connection drawer's RefsList fails the first `findAllByRole`;
    // an unconditional `useRepoGit(true, …)` fails the last `toBe(1)`.
  });

  it('178.6 a runtime value has a copy button that writes it to the clipboard; none beside an empty one', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubLive(gatewayRoutes());
    openFlow({ doc: GIT_DOC(), errors: [], exists: true });
    fireEvent.click(boxEl('gateway'));
    const drawer = screen.getByTestId('flow-drawer');

    fireEvent.click(within(drawer).getByRole('button', { name: 'copy runtime dev' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith('wrangler dev');
    await within(drawer).findByRole('button', { name: 'copied runtime dev' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'copy runtime prod' }));
    expect(writeText).toHaveBeenLastCalledWith('Cloudflare Workers');
    expect(within(drawer).queryByText('copy failed')).toBeNull();
    await settle();

    // `jobs` has a prod runtime only: its dev value is a dash and has no button.
    fireEvent.click(boxEl('jobs'));
    const jobs = screen.getByTestId('flow-drawer');
    expect(within(jobs).queryByRole('button', { name: /copy runtime dev/ })).toBeNull();
    fireEvent.click(within(jobs).getByRole('button', { name: 'copy runtime prod' }));
    expect(writeText).toHaveBeenLastCalledWith('queue consumer');
    await settle();
    // CONTROL: writing a different string (say the label) fails the three `toHaveBeenLastCalledWith`;
    // rendering the button unconditionally fails the `queryByRole(... /copy runtime dev/)` on `jobs`.
  });

  it('178.7 a refused or missing clipboard shows "copy failed"', async () => {
    stubLive(gatewayRoutes());
    openFlow({ doc: GIT_DOC(), errors: [], exists: true });
    fireEvent.click(boxEl('gateway'));
    const drawer = screen.getByTestId('flow-drawer');

    // Refused: the promise rejects.
    const refuse = vi.fn(async (_text: string) => {
      throw new Error('NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: refuse },
      configurable: true,
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'copy runtime dev' }));
    await within(drawer).findByText('copy failed');
    expect(refuse).toHaveBeenCalledWith('wrangler dev');

    // Missing (an insecure page has no `navigator.clipboard`): the same words, on the other value.
    Reflect.deleteProperty(navigator, 'clipboard');
    expect(navigator.clipboard).toBeUndefined();
    fireEvent.click(within(drawer).getByRole('button', { name: 'copy runtime prod' }));
    expect(within(drawer).getAllByText('copy failed')).toHaveLength(2);
    // CONTROL: without the `.then(_, onRejected)` branch the first `findByText` times out; without
    // the `clip === undefined` guard the second click throws a TypeError out of the handler.
  });

  it("178.8 the system drawer's Docs come from the docs route, resolved and collapsed; no docs, no section, no fetch", async () => {
    const fetchMock = stubLive(gatewayRoutes());
    openFlow({ doc: GIT_DOC(), errors: [], exists: true });
    fireEvent.click(boxEl('gateway'));
    const docs = await screen.findByTestId('flow-drawer-docs');
    // Waits for resolution: the `· N lines` span exists only once the docs route has answered.
    await within(docs).findByText(/13 lines/);
    expect(fetchMock).toHaveBeenCalledWith('/api/systems/gateway/docs');
    expect(docs).toHaveTextContent('docs/BUILD-PLAN.md:40–52');
    expect(docs.querySelectorAll('.drawer__ref-body')).toHaveLength(0); // collapsed until "show"
    expect(within(docs).getByTestId('ref-error')).toHaveTextContent('not found: docs/nope.md');
    fireEvent.click(within(docs).getByRole('button', { name: 'show' }));
    expect(docs.querySelectorAll('.drawer__ref-body')).toHaveLength(1);

    fireEvent.click(boxEl('jobs'));
    expect(
      within(screen.getByTestId('flow-drawer')).getByRole('heading', { name: 'background jobs' }),
    ).toBeInTheDocument();
    await settle();
    expect(screen.queryByTestId('flow-drawer-docs')).toBeNull();
    expect(callsTo(fetchMock, '/api/systems/jobs/docs')).toBe(0);
    // CONTROL: rendering `system.docs` as a plain list again fails `findByText(/13 lines/)`; a
    // docs fetch for a system with `docs: []` fails the last `toBe(0)`.
  });

  it('178.9 RefsList: linksFor is called once per RESOLVED ref, and absent it renders exactly as before', () => {
    const ok = okRef('a.ts:L1-L3', 'a.ts', 1, 3);
    const bad = badRef('b.ts', 'b.ts', 'not found: b.ts');
    const linksFor = vi.fn((_r: ResolvedRef) => <a href="#go">go</a>);
    const withLinks = render(<RefsList refs={[ok, bad]} collapsed linksFor={linksFor} />);
    expect(linksFor).toHaveBeenCalledTimes(1);
    expect(linksFor).toHaveBeenCalledWith(ok);
    expect(withLinks.container.querySelectorAll('a')).toHaveLength(1);
    expect(withLinks.container.querySelector('[data-testid="ref"] a')).not.toBeNull();
    cleanup();

    const plain = render(<RefsList refs={[ok, bad]} collapsed />).container.innerHTML;
    cleanup();
    const nothing = render(<RefsList refs={[ok, bad]} collapsed linksFor={() => null} />).container
      .innerHTML;
    expect(plain).not.toContain('<a ');
    expect(nothing).toBe(plain);
    // CONTROL: calling `linksFor` from the errored branch of `Reference` fails the call count;
    // wrapping the links in an always-present element fails `nothing` === `plain`.
  });
});

describe('Flow view: the selection is in the URL (RCB-176)', () => {
  beforeEach(() => {
    stubConnRefs();
  });

  it('52. selecting writes ?view=flow&system= / &conn= with replaceState, keeps other params, and closing clears it', async () => {
    window.history.replaceState(null, '', '/?repo=other');
    const pushes = vi.spyOn(window.history, 'pushState');
    const { store } = openFlow({ doc: CONN(), errors: [], exists: true });
    // Open with nothing selected: the view, and the params that were already there.
    expect(window.location.search).toBe('?repo=other&view=flow');

    fireEvent.click(hitEl('web-api'));
    expect(window.location.search).toBe('?repo=other&view=flow&conn=web,api');
    fireEvent.click(hitEl('api-db', 1));
    expect(window.location.search).toBe('?repo=other&view=flow&conn=api,db,writes');
    fireEvent.click(boxEl('web'));
    expect(window.location.search).toBe('?repo=other&view=flow&system=web');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(window.location.search).toBe('?repo=other&view=flow');

    // Leaving the view takes it back out; `repo` stays.
    fireEvent.click(boxEl('api'));
    expect(window.location.search).toBe('?repo=other&view=flow&system=api');
    await settle();
    act(() => store.setView('board'));
    expect(window.location.search).toBe('?repo=other');
    expect(pushes).not.toHaveBeenCalled();
    pushes.mockRestore();
    // CONTROL: pushState instead of replaceState fails `pushes`; no writeFlowUrl effect fails the
    // first `conn=` expectation; no unmount clear fails the last `?repo=other`; a params rebuild
    // that drops `repo` fails the very first one.
  });

  it('53. a link opens the drawer: ?view=flow&conn=web,api on a fresh page opens that connection, with its edge selected', async () => {
    stubFetch({ '/api/systems/connections/web/api/refs': [connRef('apps/web/api.ts')] });
    const { store } = openFlowAt('/?view=flow&conn=web,api', {
      doc: CONN(),
      errors: [],
      exists: true,
    });
    // The store opened on Flow because of the URL, not because a test told it to.
    expect(store.getState().view).toBe('flow');
    expect(within(connDrawer()).getByText('orders')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    expect(edgeEl('web-api').classList.contains('flow-edge--selected')).toBe(true);
    expect(window.location.search).toBe('?view=flow&conn=web,api');
    await within(connDrawer()).findByText(/1 lines/);
  });

  it('54. ...and with an id for a repeated pair; a system link opens that system with its box focused', async () => {
    const fetchMock = stubFetch({
      '/api/systems/connections/api/db/refs?id=writes': [connRef('apps/api/db.ts')],
    });
    openFlowAt('/?view=flow&conn=api,db,writes', { doc: CONN(), errors: [], exists: true });
    expect(within(connDrawer()).getByText('SQL primary')).toBeInTheDocument();
    await within(connDrawer()).findByText(/1 lines/);
    expect(fetchMock).toHaveBeenCalledWith('/api/systems/connections/api/db/refs?id=writes');
    expect(edgeEls('api-db')[1]?.classList.contains('flow-edge--selected')).toBe(true);
  });

  it('55. a system link: ?view=flow&system=web opens that drawer and focuses the box', () => {
    openFlowAt('/?view=flow&system=web', { doc: CONN(), errors: [], exists: true });
    expect(within(screen.getByTestId('flow-drawer')).getByText('web client')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-conn-drawer')).toBeNull();
    // web's only neighbour is api: db is dimmed.
    expect(dimmedBoxes()).toEqual(['db']);
    expect(window.location.search).toBe('?view=flow&system=web');
  });

  it('56. an unknown or malformed id opens nothing and is written out of the URL; an ambiguous pair too', () => {
    const doc = { doc: CONN(), errors: [], exists: true };
    for (const bad of [
      'conn=web,nowhere',
      'conn=nowhere,api',
      'system=nowhere',
      'conn=api,db', // two rows, no id: which one?
      'conn=api,db,nope',
      'conn=WEB,api', // not [a-z0-9-]+
      'conn=web',
      'conn=web,api,x,y',
    ]) {
      openFlowAt(`/?view=flow&${bad}`, doc);
      expect(screen.queryByTestId('flow-conn-drawer'), bad).toBeNull();
      expect(screen.queryByTestId('flow-drawer'), bad).toBeNull();
      expect(window.location.search, bad).toBe('?view=flow');
      cleanupFlow();
    }
    // CONTROL: a resolver that took an unknown id at its word (or picked the first row of an
    // ambiguous pair) opens a drawer or leaves the id in the URL, failing here on the named case.
  });

  it('57. before the first snapshot the URL selection is kept (Loading…), then honoured once the doc arrives', async () => {
    stubFetch({ '/api/systems/connections/web/api/refs': [connRef('apps/web/api.ts')] });
    window.history.replaceState(null, '', '/?view=flow&conn=web,api');
    const store = testStore();
    renderApp(store);
    expect(store.getState().view).toBe('flow');
    expect(screen.getByTestId('flow')).toHaveTextContent('Loading…');
    expect(window.location.search).toBe('?view=flow&conn=web,api');
    act(() => {
      store.dispatch({
        type: 'snapshot',
        board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')], hasBoard: true },
        repo: null,
        systems: { doc: CONN(), errors: [], exists: true },
      });
    });
    expect(within(connDrawer()).getByText('orders')).toBeInTheDocument();
    expect(window.location.search).toBe('?view=flow&conn=web,api');
    await settle();
    // CONTROL: writing the URL while `systems` is still null erases the link -> the last two
    // expectations fail (and the drawer never opens).
  });

  it('58. a map-only repo (no board) still opens on Flow when the URL says so, and on Map when it does not', () => {
    window.history.replaceState(null, '', '/?view=flow');
    const flow = testStore();
    flow.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [], hasBoard: false },
      repo: null,
    });
    expect(flow.getState().view).toBe('flow');
    window.history.replaceState(null, '', '/');
    const plain = testStore();
    expect(plain.getState().view).toBe('board');
    plain.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [], hasBoard: false },
      repo: null,
    });
    expect(plain.getState().view).toBe('map');
    // CONTROL: no `initialView()` fails the first `flow` expectation; no `state.view === 'board'`
    // guard on the map-only default fails it too (it would say `map`).
  });

  it('59. CONTROL: parseFlowSelection reads system= / conn= (2 or 3 ids), ignores anything else, conn wins', () => {
    expect(parseFlowSelection('?view=flow&system=api')).toEqual({ kind: 'system', id: 'api' });
    expect(parseFlowSelection('?view=flow&conn=web,api')).toEqual({
      kind: 'conn',
      from: 'web',
      to: 'api',
      id: null,
    });
    expect(parseFlowSelection('?conn=web%2Capi%2Cx-1')).toEqual({
      kind: 'conn',
      from: 'web',
      to: 'api',
      id: 'x-1',
    });
    expect(parseFlowSelection('?system=a&conn=b,c')).toEqual({
      kind: 'conn',
      from: 'b',
      to: 'c',
      id: null,
    });
    // A bad conn falls back to a good system, never half-reads.
    expect(parseFlowSelection('?conn=B,c&system=a')).toEqual({ kind: 'system', id: 'a' });
    for (const bad of [
      '',
      '?view=flow',
      '?system=',
      '?system=A',
      '?system=a b',
      '?conn=',
      '?conn=a',
      '?conn=a,,b',
      '?conn=a,b,c,d',
      '?conn=a;b',
    ]) {
      expect(parseFlowSelection(bad), bad).toBeNull();
    }
  });

  it('60. CONTROL: flowSearch sets view+selection and keeps the rest (comma plain); clearedFlowSearch removes only its own keys', () => {
    expect(flowSearch('', null)).toBe('?view=flow');
    expect(flowSearch('?repo=x', { kind: 'system', id: 'api' })).toBe(
      '?repo=x&view=flow&system=api',
    );
    expect(
      flowSearch('?repo=x&view=flow&system=api', { kind: 'conn', from: 'a', to: 'b', id: null }),
    ).toBe('?repo=x&view=flow&conn=a,b');
    expect(flowSearch('?conn=a,b', { kind: 'conn', from: 'a', to: 'b', id: 'r1' })).toBe(
      '?view=flow&conn=a,b,r1',
    );
    expect(flowSearch('?view=flow&conn=a,b', null)).toBe('?view=flow');
    expect(clearedFlowSearch('?repo=x&view=flow&conn=a,b')).toBe('?repo=x');
    expect(clearedFlowSearch('?view=flow&system=a')).toBe('');
    // `view` is only ours when it is `flow`.
    expect(clearedFlowSearch('?view=board&system=a')).toBe('?view=board');
  });
});

/** Unmounts everything a test mounted — for a test that opens several pages in a row. */
function cleanupFlow(): void {
  cleanup();
}

// ---- RCB-180: the summary strip and the path walk-throughs -------------------------------------

const PATH_SRC = 'source: { hand: "owner", at: "2026-09-29T00:00:00Z" }';
/** two-env.yml plus three paths: `page load` (all four hops in both envs), `mail` (api → sendgrid:
 * a dev-only connection) and `nightly` (worker-jobs → postgres: prod-only). */
const PATHS_YML = `${TWO_ENV_YML}paths:
  - name: page load
    hops: [web, gateway, api, postgres]
    ${PATH_SRC}
  - name: mail
    hops: [api, sendgrid]
    ${PATH_SRC}
  - name: nightly
    hops: [worker-jobs, postgres]
    ${PATH_SRC}
`;
const PATHS_DOC = () => parsedDoc(PATHS_YML);

function pathsSelect(): HTMLSelectElement {
  return screen.getByTestId('flow-paths') as HTMLSelectElement;
}
function choosePathByName(name: string): void {
  fireEvent.change(pathsSelect(), { target: { value: name } });
}
/** The ids in one strip group, in the order shown. */
function stripIds(group: 'data' | 'external' | 'entry'): string[] {
  return within(screen.getByTestId(`flow-group-${group}`))
    .queryAllByRole('button')
    .map((b) => b.textContent ?? '');
}
function litEdges(): string[] {
  return [...screen.getByTestId('flow-svg').querySelectorAll('.flow-edge--hop')]
    .map((g) => g.getAttribute('data-edge') ?? '')
    .sort();
}

describe('Flow view: the summary strip (RCB-180)', () => {
  it('61. the strip has three labelled groups with counts, ids as buttons, in systems: file order', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    expect(screen.getByTestId('flow-strip')).toBeInTheDocument();
    expect(screen.getByTestId('flow-group-data')).toHaveTextContent('Data stores (1)');
    expect(screen.getByTestId('flow-group-external')).toHaveTextContent('Externals (1)');
    expect(screen.getByTestId('flow-group-entry')).toHaveTextContent('Entry points (2)');
    expect(stripIds('data')).toEqual(['postgres']);
    expect(stripIds('external')).toEqual(['sendgrid']);
    expect(stripIds('entry')).toEqual(['web', 'worker-jobs']);
    // CONTROL: counting from the wrong list fails a count line; drawing the ids in layout order
    // rather than file order is caught by core's own ordering test, not here.
  });

  it('62. the strip follows the env: an empty group reads `none` with a 0 count, and the others move', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    // sendgrid is dev-only: prod has no external.
    expect(screen.getByTestId('flow-group-external')).toHaveTextContent('Externals (0)');
    expect(screen.getByTestId('flow-group-external')).toHaveTextContent('none');
    expect(stripIds('external')).toEqual([]);
    expect(stripIds('entry')).toEqual(['web', 'worker-jobs']);
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    // worker-jobs is prod-only: dev has one entry point, and the external is back.
    expect(stripIds('entry')).toEqual(['web']);
    expect(screen.getByTestId('flow-group-entry')).toHaveTextContent('Entry points (1)');
    expect(stripIds('external')).toEqual(['sendgrid']);
    expect(screen.getByTestId('flow-group-external')).not.toHaveTextContent('none');
    // CONTROL: a strip built from `doc.systems` instead of `flowOverview(doc, env)` keeps
    // sendgrid in prod and worker-jobs in dev and fails both; dropping the `none` literal fails
    // the prod `none` line.
  });

  it('63. clicking an id in the strip selects that box exactly as clicking the box does', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    expect(screen.queryByTestId('flow-drawer')).toBeNull();
    fireEvent.click(
      within(screen.getByTestId('flow-group-data')).getByRole('button', { name: 'postgres' }),
    );
    const drawer = screen.getByTestId('flow-drawer');
    expect(drawer).toHaveTextContent('postgres');
    expect(boxEl('postgres').classList.contains('flow-box--selected')).toBe(true);
    // The same focus a click on the box gives (test 23): postgres's neighbours stay lit.
    expect(dimmedBoxes()).toEqual(['gateway', 'sendgrid', 'web']);
    expect(window.location.search).toContain('system=postgres');
    // an entry point too
    fireEvent.click(
      within(screen.getByTestId('flow-group-entry')).getByRole('button', { name: 'web' }),
    );
    expect(boxEl('web').classList.contains('flow-box--selected')).toBe(true);
    expect(boxEl('postgres').classList.contains('flow-box--selected')).toBe(false);
    // CONTROL: an onClick that does nothing (or that only sets the focus, not the selection)
    // leaves the drawer and the `--selected` class unchecked and fails here.
  });

  it('64. no strip when there is no diagram: no file, an invalid file, a `none` environment', () => {
    openFlow({ doc: null, errors: [], exists: false });
    expect(screen.queryByTestId('flow-strip')).toBeNull();
    cleanup();
    openFlow({ doc: null, errors: ['systems[0]: bad'], exists: true });
    expect(screen.queryByTestId('flow-strip')).toBeNull();
    cleanup();
    openFlow({ doc: NONE_PROD(), errors: [], exists: true });
    expect(screen.getByTestId('flow-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(screen.queryByTestId('flow-strip')).toBeNull();
  });
});

describe('Flow view: path walk-throughs (RCB-180)', () => {
  it('65. no `paths:` in the file: no Paths control', () => {
    openFlow({ doc: TWO_ENV(), errors: [], exists: true });
    expect(screen.queryByTestId('flow-paths')).toBeNull();
    expect(screen.queryByLabelText('Paths')).toBeNull();
  });

  it("66. choosing a path starts at step 1 of n: that hop's edge and two boxes lit, the rest dimmed; Next / Prev step it", () => {
    openFlow({ doc: PATHS_DOC(), errors: [], exists: true });
    // Nothing chosen yet: nothing dims and there are no step controls.
    expect(pathsSelect().value).toBe('');
    expect(dimmedBoxes()).toEqual([]);
    expect(screen.queryByTestId('flow-path-step')).toBeNull();

    choosePathByName('page load');
    expect(pathsSelect().value).toBe('page load');
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 1 of 3');
    expect(screen.getByTestId('flow-path-hop')).toHaveTextContent('web → gateway');
    // Step 1: web → gateway. Only that edge and those two boxes are lit.
    expect(dimmedBoxes()).toEqual(['api', 'postgres', 'sendgrid', 'worker-jobs']);
    expect(dimmedEdges()).toEqual([
      'api-postgres',
      'api-sendgrid',
      'gateway-api',
      'worker-jobs-postgres',
    ]);
    expect(litEdges()).toEqual(['web-gateway']);
    expect(boxEl('web').classList.contains('flow-box--hop')).toBe(true);
    expect(boxEl('api').classList.contains('flow-box--hop')).toBe(false);
    // The first step has no Prev.
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 2 of 3');
    expect(screen.getByTestId('flow-path-hop')).toHaveTextContent('gateway → api');
    expect(dimmedBoxes()).toEqual(['postgres', 'sendgrid', 'web', 'worker-jobs']);
    expect(litEdges()).toEqual(['gateway-api']);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 3 of 3');
    // api → postgres: api's OTHER edge (to sendgrid) is not on the hop and dims.
    expect(dimmedBoxes()).toEqual(['gateway', 'sendgrid', 'web', 'worker-jobs']);
    expect(dimmedEdges()).toEqual([
      'api-sendgrid',
      'gateway-api',
      'web-gateway',
      'worker-jobs-postgres',
    ]);
    expect(litEdges()).toEqual(['api-postgres']);
    // The last step has no Next.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 2 of 3');
    expect(litEdges()).toEqual(['gateway-api']);

    // Choosing a path starts it over at step 1 — even the one just left at step 2.
    choosePathByName('');
    choosePathByName('page load');
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 1 of 3');
    expect(litEdges()).toEqual(['web-gateway']);
    choosePathByName('nightly');
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 1 of 1');
    expect(litEdges()).toEqual(['worker-jobs-postgres']);
    // CONTROL: lighting the edges of ALL hops (or matching only `e.from` to `hop.from`) fails the
    // `litEdges` / `dimmedEdges` lines at steps 1 and 3; a step that does not reset on choose fails
    // the "Step 1 of 3" line after re-choosing; enabling Prev at step 1 or Next at the end fails the disabled lines.
  });

  it('67. a hop with parallel connection rows (RCB-173 ids) lights every one of them', () => {
    const doc = parsedDoc(`${CONN_YML}paths:
  - name: write path
    hops: [web, api, db]
    ${PATH_SRC}
`);
    openFlow({ doc, errors: [], exists: true });
    choosePathByName('write path');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // api → db: `reads` and `writes` are two polylines with the same data-edge.
    const svg = screen.getByTestId('flow-svg');
    const apiDb = [...svg.querySelectorAll('[data-edge="api-db"]')];
    expect(apiDb).toHaveLength(2);
    expect(apiDb.every((e) => !e.classList.contains('flow-edge--dim'))).toBe(true);
    expect(apiDb.every((e) => e.classList.contains('flow-edge--hop'))).toBe(true);
    expect(edgeEl('web-api').classList.contains('flow-edge--dim')).toBe(true);
    // CONTROL: lighting only the first row of a pair (e.g. a `find` in place of the comparison)
    // leaves one `api-db` polyline dimmed and fails the `every` lines.
  });

  it('68. Esc ends the walk (one Esc), then clears a focus (the next); `none` and Esc on the select end it too', () => {
    openFlow({ doc: PATHS_DOC(), errors: [], exists: true });
    // A focus first: click api (lit: gateway, postgres, sendgrid; dim web, worker-jobs).
    fireEvent.click(boxEl('api'));
    expect(dimmedBoxes()).toEqual(['web', 'worker-jobs']);
    choosePathByName('page load');
    // The walk takes over the dimming while it runs.
    expect(dimmedBoxes()).toEqual(['api', 'postgres', 'sendgrid', 'worker-jobs']);

    fireEvent.keyDown(screen.getByTestId('flow-canvas'), { key: 'Escape' });
    expect(pathsSelect().value).toBe('');
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    // The walk is over; the focus it had covered is back.
    expect(dimmedBoxes()).toEqual(['web', 'worker-jobs']);
    fireEvent.keyDown(screen.getByTestId('flow-canvas'), { key: 'Escape' });
    expect(dimmedBoxes()).toEqual([]);

    // The `none` option ends it.
    choosePathByName('page load');
    expect(screen.getByTestId('flow-path-step')).toBeInTheDocument();
    choosePathByName('');
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    expect(dimmedBoxes()).toEqual([]);

    // Esc with the focus on the select, and on a step button, ends it too.
    choosePathByName('page load');
    fireEvent.keyDown(pathsSelect(), { key: 'Escape' });
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    choosePathByName('page load');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), { key: 'Escape' });
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    expect(dimmedBoxes()).toEqual([]);
    // CONTROL: an Esc handler that leaves the walk running fails the first `select.value` line; one
    // that clears both walk and focus at once fails the "focus it had covered is back" line.
  });

  it('69. a path with a hop the env does not draw is listed disabled with `(not in <env>)`; an env switch that breaks a walk ends it', () => {
    openFlow({ doc: PATHS_DOC(), errors: [], exists: true });
    const option = (name: string) =>
      [...pathsSelect().options].find((o) => o.value === name) as HTMLOptionElement;
    // "both" draws everything: every path can be walked.
    expect([...pathsSelect().options].map((o) => [o.value, o.disabled])).toEqual([
      ['', false],
      ['page load', false],
      ['mail', false],
      ['nightly', false],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    // api → sendgrid is dev-only.
    expect(option('mail').disabled).toBe(true);
    expect(option('mail').textContent).toBe('mail (not in prod)');
    expect(option('page load').disabled).toBe(false);
    expect(option('page load').textContent).toBe('page load');
    expect(option('nightly').disabled).toBe(false);
    // Picking a disabled one anyway (a script, a stale value) starts nothing.
    choosePathByName('mail');
    expect(pathsSelect().value).toBe('');
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    expect(dimmedBoxes()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    // worker-jobs is prod-only.
    expect(option('nightly').disabled).toBe(true);
    expect(option('nightly').textContent).toBe('nightly (not in dev)');
    expect(option('mail').disabled).toBe(false);

    // A walk in progress ends when the env stops drawing it, and does not resume on the way back.
    choosePathByName('mail');
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 1 of 1');
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(pathsSelect().value).toBe('');
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    expect(dimmedBoxes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    expect(pathsSelect().value).toBe('');
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    // CONTROL: `disabled={false}` fails the option lines; a label without the env name fails the
    // text lines; dropping the walk-ends effect leaves the walk to resume and fails the last two.
  });

  it('70. a live systems.yml edit: a shortened path clamps the step to its new last one; a removed path ends the walk', () => {
    const { store } = openFlow({ doc: PATHS_DOC(), errors: [], exists: true });
    choosePathByName('page load');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 3 of 3');

    const shorter = parsedDoc(
      PATHS_YML.replace('hops: [web, gateway, api, postgres]', 'hops: [web, gateway]'),
    );
    act(() => store.dispatch({ type: 'systems', doc: shorter, errors: [], exists: true }));
    // Still walking the same path (by name), at the last step it now has.
    expect(pathsSelect().value).toBe('page load');
    expect(screen.getByTestId('flow-path-step')).toHaveTextContent('Step 1 of 1');
    expect(screen.getByTestId('flow-path-hop')).toHaveTextContent('web → gateway');

    act(() => store.dispatch({ type: 'systems', doc: TWO_ENV(), errors: [], exists: true }));
    expect(screen.queryByTestId('flow-paths')).toBeNull();
    expect(screen.queryByTestId('flow-path-step')).toBeNull();
    expect(dimmedBoxes()).toEqual([]);
    // CONTROL: without the clamp the step is past the end, there is no hop, and the walk ends
    // instead of shortening — the first block fails on `select.value`.
  });

  it('71. CONTROL: pathSteps, pathDrawn and hopRect (pure)', () => {
    const doc = PATHS_DOC();
    const [pageLoad, mail] = doc.paths ?? [];
    if (!pageLoad || !mail) throw new Error('fixture lost its paths');
    expect(pathSteps(pageLoad)).toEqual([
      { from: 'web', to: 'gateway' },
      { from: 'gateway', to: 'api' },
      { from: 'api', to: 'postgres' },
    ]);
    expect(pathSteps({ ...pageLoad, hops: ['web'] })).toEqual([]);
    expect(pathDrawn(pageLoad, layoutSystems(doc, 'prod'))).toBe(true);
    expect(pathDrawn(mail, layoutSystems(doc, 'dev'))).toBe(true);
    expect(pathDrawn(mail, layoutSystems(doc, 'prod'))).toBe(false);
    // A path with fewer than two hops has no step to draw.
    expect(pathDrawn({ ...pageLoad, hops: ['web'] }, layoutSystems(doc, 'both'))).toBe(false);
    // hopRect: the two boxes and the edge, padded — read the boxes back from the DOM.
    const layout = layoutSystems(doc, 'both');
    const rect = hopRect(layout, { from: 'web', to: 'gateway' });
    expect(rect).not.toBeNull();
    if (rect === null) return;
    openFlow({ doc, errors: [], exists: true });
    for (const id of ['web', 'gateway']) {
      const r = boxEl(id).querySelector('rect');
      const x = Number(r?.getAttribute('x'));
      const y = Number(r?.getAttribute('y'));
      const w = Number(r?.getAttribute('width'));
      const h = Number(r?.getAttribute('height'));
      expect(rect.x).toBeLessThan(x);
      expect(rect.y).toBeLessThan(y);
      expect(rect.x + rect.w).toBeGreaterThan(x + w);
      expect(rect.y + rect.h).toBeGreaterThan(y + h);
    }
    // ...and it holds nothing that is not on the hop: the api box (one row down and right) is out.
    const apiRect = boxEl('api').querySelector('rect');
    expect(rect.y + rect.h).toBeLessThan(Number(apiRect?.getAttribute('y')));
    expect(hopRect(layout, { from: 'nowhere', to: 'nope' })).toBeNull();
  });

  it('72. each step pans, minimally, to show its two boxes: a hop far to the right comes into view, then the first hop again', () => {
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 960,
          height: 600,
          right: 960,
          bottom: 600,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const link = (from: string, to: string) =>
        `  - from: ${from}\n    to: ${to}\n    env: [dev, prod]\n    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }\n`;
      const doc = parsedDoc(
        `${wideYml()}${link('s02', 's09')}${link('s09', 's10')}paths:
  - name: across
    hops: [s01, s02, s09, s10]
    ${PATH_SRC}
`,
      );
      openFlow({ doc, errors: [], exists: true });
      fireEvent.click(screen.getByRole('button', { name: '100%' }));
      const visible = (id: string) => {
        const t = viewportTransform();
        const x = Number(boxEl(id).querySelector('rect')?.getAttribute('x'));
        return t.x + x * t.k >= 0 && t.x + (x + 170) * t.k <= 960;
      };
      // At 100% about the centre of a 2,593 px diagram, both ends are off screen.
      expect(visible('s01')).toBe(false);
      expect(visible('s10')).toBe(false);

      choosePathByName('across');
      expect(visible('s01')).toBe(true);
      expect(visible('s02')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByTestId('flow-path-hop')).toHaveTextContent('s09 → s10');
      expect(visible('s09')).toBe(true);
      expect(visible('s10')).toBe(true);
      expect(viewportTransform().k).toBe(1);
      fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
      fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
      expect(visible('s01')).toBe(true);
      expect(visible('s02')).toBe(true);
    } finally {
      rectSpy.mockRestore();
    }
    // CONTROL: deleting the reveal effect leaves s01/s02 (then s09/s10) where they were and fails
    // the `visible` lines.
  });
});
