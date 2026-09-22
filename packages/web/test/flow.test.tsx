/**
 * RCB-98 (plan docs/SYSTEMS-FLOW-PLAN.md §3.4): the Flow view — third top-level view, beside
 * Board and Map. Follows `map.test.tsx`'s pattern (seed the store with a raw `dispatch`, no
 * socket) and `refs.test.tsx`'s pattern for mocking `fetch` under the drawer's live pointer
 * resolution.
 *
 * The fixture text below is pasted from `packages/core/test/fixtures/systems/{two-env,none-prod}.yml`
 * (RCB-95's own fixtures) and parsed through `parseSystems`, per the brief — not re-derived.
 */
import { defaultBoardConfig, parseSystems, type SystemsDoc } from '@repoboard/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store.js';
import { card, renderApp, testStore } from './helpers.jsx';

const TWO_ENV_YML = `environments:
  dev:  { note: "vite dev :5173 + wrangler dev :8787 + local postgres :5433" }
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
    runtime: { dev: "local postgres :5433", prod: "Neon via Hyperdrive" }
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

function parsedDoc(text: string): SystemsDoc {
  const result = parseSystems(text);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.errors.join('; ')}`);
  return result.doc;
}

const TWO_ENV = () => parsedDoc(TWO_ENV_YML);
const NONE_PROD = () => parsedDoc(NONE_PROD_YML);

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
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0);
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
    expect(testsSection).not.toHaveTextContent('test/gateway.test.ts');

    fireEvent.click(within(testsSection).getByRole('button', { name: 'show' }));
    await within(testsSection).findByText(/test\/gateway\.test\.ts/);
    expect(testsSection).toHaveTextContent('apps/gateway/src/index.ts');
    expect(testsSection).toHaveTextContent(
      'static: test files that import or name the pointer, read live',
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
      },
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
