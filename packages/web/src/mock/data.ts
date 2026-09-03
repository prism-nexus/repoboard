import { type BoardConfig, type Card, defaultBoardConfig, type RepoSnapshot } from '@rcb/core';

export const MOCK_ACTORS = ['claude/web-agent', 'claude/server-agent', 'claude/core-agent', 'matt'];

const min = 60_000;

function card(
  n: number,
  title: string,
  status: string,
  ageMin: number,
  extra: Partial<Card> & { log?: string[] } = {},
  now = Date.now(),
): Card {
  const updated = new Date(now - ageMin * min).toISOString();
  const created = new Date(now - (ageMin + 240) * min).toISOString();
  const { log = [], ...rest } = extra;
  const body = [
    `Task ${title.split(' ')[0]} in \`docs/BUILD-PLAN.md\` §5. DoD lives there.`,
    '',
    '- reads **plan §3** for the wire contract',
    '- keeps `updated` honest',
    ...(log.length ? ['', '## Log', ...log.map((l) => `- ${l}`)] : []),
    '',
  ].join('\n');
  return { id: `RCB-${n}`, title, status, created, updated, body, ...rest };
}

export function mockConfig(): BoardConfig {
  return defaultBoardConfig();
}

export function mockCards(now = Date.now()): Card[] {
  const t = (ago: number) => new Date(now - ago * min).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    card(3, 'P1.1 Card schema, parse/serialize, round-trip', 'done', 120, {
      assignee: 'claude/core-agent',
      priority: 'high',
      labels: ['core'],
      files: ['packages/core/src/card.ts', 'packages/core/test/card.test.ts'],
      log: [
        `${t(300)} claude/orchestrator — moved todo → doing`,
        `${t(120)} claude/orchestrator — moved → done, 61/61 tests`,
      ],
    }),
    card(4, 'P1.2 Board config, defaults, WIP', 'done', 95, {
      assignee: 'claude/core-agent',
      priority: 'medium',
      labels: ['core'],
      files: ['packages/core/src/board.ts'],
    }),
    card(7, 'P2.1 CLI: init, card add/move/list/show, serve', 'doing', 4, {
      assignee: 'claude/server-agent',
      priority: 'high',
      labels: ['server'],
      files: ['packages/server/src/cli.ts', 'packages/server/src/store.ts'],
      log: [
        `${t(40)} claude/orchestrator — moved todo → doing, dispatched to server-agent`,
        `${t(4)} claude/server-agent — cli parses; serve next`,
      ],
    }),
    card(8, 'P2.2 HTTP + WS server, watcher echo', 'doing', 11, {
      assignee: 'claude/server-agent',
      priority: 'high',
      labels: ['server', 'ws'],
      files: [
        'packages/server/src/http.ts',
        'packages/server/src/ws.ts',
        'packages/server/src/watch.ts',
      ],
    }),
    card(12, 'P3.1 Board shell, WS client, columns', 'doing', 1, {
      assignee: 'claude/web-agent',
      priority: 'high',
      labels: ['web'],
      files: [
        'packages/web/src/ws.ts',
        'packages/web/src/store.ts',
        'packages/web/src/views/Board.tsx',
      ],
      log: [
        `${t(35)} claude/orchestrator — moved todo → doing, dispatched to web-agent`,
        `${t(1)} claude/web-agent — store and socket wired; columns render`,
      ],
    }),
    card(13, 'P3.3 Card drawer with markdown and log', 'review', 25, {
      assignee: 'claude/web-agent',
      priority: 'medium',
      labels: ['web'],
      files: ['packages/web/src/components/Drawer.tsx'],
      log: [`${t(25)} claude/web-agent — ready for review`],
    }),
    card(14, 'P3.4 Ticker, avatars, fun layer', 'todo', 60, {
      priority: 'medium',
      labels: ['web', 'fun'],
    }),
    card(15, 'P3.5 web tests + bundle size control', 'todo', 62, {
      priority: 'high',
      labels: ['web', 'test'],
    }),
    card(16, 'P4.1 Treemap of files by size', 'backlog', 200, {
      priority: 'medium',
      labels: ['web', 'viz'],
    }),
    card(17, 'P4.2 Git activity heat overlay', 'backlog', 201, {
      priority: 'low',
      labels: ['web', 'viz'],
    }),
    card(18, 'P4.3 Who is where: files glow with assignee color', 'backlog', 202, {
      priority: 'medium',
      labels: ['web', 'viz'],
    }),
    card(20, 'P5.1 MCP server: list, get, create, move, update, append_log', 'backlog', 210, {
      priority: 'high',
      labels: ['mcp'],
    }),
    card(23, 'P6.2 npx rcb works from npm pack', 'backlog', 220, {
      priority: 'low',
      labels: ['infra'],
    }),
    card(24, 'Write the AGENTS.md one-pager', 'todo', 90, {
      assignee: 'matt',
      priority: 'low',
      labels: ['docs'],
    }),
  ];
}

export function mockRepo(now = Date.now()): RepoSnapshot {
  const iso = (agoMin: number) => new Date(now - agoMin * min).toISOString();
  const f = (
    path: string,
    bytes: number,
    lang: string,
    commits30d: number,
    lastAgoMin: number | null,
    lines: number | null = Math.round(bytes / 32),
  ): RepoSnapshot['files'][number] => ({
    path,
    bytes,
    lines,
    lang,
    commits30d,
    commits90d: commits30d + (lastAgoMin === null ? 0 : 3),
    lastCommitAt: lastAgoMin === null ? null : iso(lastAgoMin),
  });
  const files = [
    f('packages/core/src/card.ts', 6200, 'typescript', 9, 60),
    f('packages/core/src/board.ts', 3100, 'typescript', 4, 300),
    f('packages/core/src/presence.ts', 2800, 'typescript', 3, 1500),
    f('packages/core/src/transitions.ts', 5400, 'typescript', 6, 30),
    f('packages/core/src/types.ts', 1900, 'typescript', 5, 20),
    f('packages/core/src/index.ts', 900, 'typescript', 7, 20),
    f('packages/core/test/card.test.ts', 7400, 'typescript', 8, 60),
    f('packages/server/src/cli.ts', 8800, 'typescript', 12, 5),
    f('packages/server/src/store.ts', 7100, 'typescript', 10, 5),
    f('packages/server/src/http.ts', 15200, 'typescript', 11, 90),
    f('packages/server/src/scanner.ts', 9600, 'typescript', 4, 4000),
    f('packages/server/src/index.ts', 600, 'typescript', 2, 4000),
    f('packages/web/src/App.tsx', 2400, 'tsx', 6, 10),
    f('packages/web/src/store.ts', 8300, 'typescript', 9, 10),
    f('packages/web/src/views/Board.tsx', 5200, 'tsx', 7, 45),
    f('packages/web/src/views/Map.tsx', 9100, 'tsx', 3, 1),
    f('packages/web/src/views/Treemap.tsx', 8700, 'tsx', 2, 1),
    f('packages/web/src/components/CardItem.tsx', 3100, 'tsx', 5, 45),
    f('packages/web/src/components/Drawer.tsx', 6900, 'tsx', 4, 200),
    f('packages/web/src/styles.css', 21000, 'css', 8, 1),
    f('packages/web/index.html', 400, 'html', 1, 9000),
    f('docs/BUILD-PLAN.md', 14000, 'markdown', 3, 700),
    f('docs/HANDOFF.md', 22000, 'markdown', 9, 60),
    f('README.md', 4200, 'markdown', 2, 700),
    f('CLAUDE.md', 5100, 'markdown', 1, 2000),
    f('package.json', 900, 'json', 2, 700),
    f('pnpm-lock.yaml', 180000, 'lock', 2, 700, null),
    f('docs/demo.gif', 640000, 'image', 0, null, null),
    f('.rcb/board.yml', 300, 'yaml', 1, 20),
    f('.rcb/cards/RCB-7.md', 800, 'markdown', 4, 4),
  ];
  const languages: Record<string, number> = {};
  for (const x of files) languages[x.lang] = (languages[x.lang] ?? 0) + x.bytes;
  const e = (from: string, to: string) => ({ from, to });
  return {
    root: '/Users/you/Projects/rcb',
    scannedAt: new Date(now).toISOString(),
    files,
    edges: [
      e('packages/core/src/index.ts', 'packages/core/src/card.ts'),
      e('packages/core/src/index.ts', 'packages/core/src/board.ts'),
      e('packages/core/src/index.ts', 'packages/core/src/presence.ts'),
      e('packages/core/src/index.ts', 'packages/core/src/transitions.ts'),
      e('packages/core/src/index.ts', 'packages/core/src/types.ts'),
      e('packages/core/src/card.ts', 'packages/core/src/types.ts'),
      e('packages/core/src/board.ts', 'packages/core/src/types.ts'),
      e('packages/core/src/presence.ts', 'packages/core/src/board.ts'),
      e('packages/core/src/presence.ts', 'packages/core/src/types.ts'),
      e('packages/core/src/transitions.ts', 'packages/core/src/card.ts'),
      e('packages/core/src/transitions.ts', 'packages/core/src/board.ts'),
      e('packages/core/test/card.test.ts', 'packages/core/src/card.ts'),
      e('packages/server/src/cli.ts', 'packages/server/src/store.ts'),
      e('packages/server/src/cli.ts', 'packages/server/src/http.ts'),
      e('packages/server/src/http.ts', 'packages/server/src/store.ts'),
      e('packages/server/src/http.ts', 'packages/server/src/scanner.ts'),
      e('packages/server/src/index.ts', 'packages/server/src/http.ts'),
      e('packages/server/src/index.ts', 'packages/server/src/store.ts'),
      e('packages/web/src/App.tsx', 'packages/web/src/store.ts'),
      e('packages/web/src/App.tsx', 'packages/web/src/views/Board.tsx'),
      e('packages/web/src/App.tsx', 'packages/web/src/views/Map.tsx'),
      e('packages/web/src/App.tsx', 'packages/web/src/components/Drawer.tsx'),
      e('packages/web/src/views/Board.tsx', 'packages/web/src/components/CardItem.tsx'),
      e('packages/web/src/views/Board.tsx', 'packages/web/src/store.ts'),
      e('packages/web/src/views/Map.tsx', 'packages/web/src/views/Treemap.tsx'),
      e('packages/web/src/views/Map.tsx', 'packages/web/src/store.ts'),
    ],
    languages,
    head: { branch: 'main', sha: 'a1b2c3d4e5f6' },
  };
}
