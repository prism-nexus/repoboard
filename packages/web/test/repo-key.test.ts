/**
 * RCB-43 slice 3: the one base-path rule, in isolation — no fetch, no DOM, no store. See
 * `docs/RCB-43-MULTIROOT-BRIEF.md` §"Slice 3 — detailed brief".
 */
import { describe, expect, it } from 'vitest';
import { apiPath, locationForRepo, repoKeyFromLocation, wsPath } from '../src/repo-key.js';
import { eventsPathFromWsUrl } from '../src/ws.js';

describe('apiPath', () => {
  it('returns the path unchanged when key is null', () => {
    expect(apiPath('/api/board', null)).toBe('/api/board');
  });
  it('prefixes with /api/repos/<key> when a key is given', () => {
    expect(apiPath('/api/board', 'fpj')).toBe('/api/repos/fpj/board');
  });
  it('preserves nested segments after the prefix', () => {
    expect(apiPath('/api/cards/RB-1/decide', 'fpj')).toBe('/api/repos/fpj/cards/RB-1/decide');
  });
  it('preserves a query string after the prefix', () => {
    expect(apiPath('/api/events?since=0', 'fpj')).toBe('/api/repos/fpj/events?since=0');
  });
  it('encodes the key', () => {
    expect(apiPath('/api/board', 'a b')).toBe('/api/repos/a%20b/board');
  });
  it('throws on a path that does not start with /api/', () => {
    expect(() => apiPath('/ws', 'fpj')).toThrow();
    expect(() => apiPath('api/board', 'fpj')).toThrow();
    expect(() => apiPath('/apix/board', 'fpj')).toThrow();
  });
  it('throws on a non-/api/ path even with a null key', () => {
    expect(() => apiPath('/ws', null)).toThrow();
  });
});

describe('wsPath', () => {
  it('is /ws with no key', () => {
    expect(wsPath(null)).toBe('/ws');
  });
  it('is the scoped ws path with a key', () => {
    expect(wsPath('fpj')).toBe('/api/repos/fpj/ws');
  });
  it('encodes the key', () => {
    expect(wsPath('a b')).toBe('/api/repos/a%20b/ws');
  });
});

describe('repoKeyFromLocation', () => {
  it('is null with no query string', () => {
    expect(repoKeyFromLocation({ search: '' })).toBeNull();
  });
  it('is null when repo= is present but empty', () => {
    expect(repoKeyFromLocation({ search: '?repo=' })).toBeNull();
  });
  it('decodes the value', () => {
    expect(repoKeyFromLocation({ search: '?repo=a%20b' })).toBe('a b');
  });
  it('trims the value', () => {
    expect(repoKeyFromLocation({ search: '?repo=%20fpj%20' })).toBe('fpj');
  });
  it('is null when a different param is present', () => {
    expect(repoKeyFromLocation({ search: '?view=map' })).toBeNull();
  });
  it('reads repo alongside other params', () => {
    expect(repoKeyFromLocation({ search: '?view=map&repo=fpj' })).toBe('fpj');
  });
});

describe('locationForRepo', () => {
  it('is the plain, query-stripped path for the primary', () => {
    expect(locationForRepo('a', 'a')).toBe('/');
  });
  it('is the plain path for null (no explicit key)', () => {
    expect(locationForRepo(null, 'a')).toBe('/');
  });
  it('is /?repo=<key> for a non-primary key', () => {
    expect(locationForRepo('b', 'a')).toBe('/?repo=b');
  });
  it('encodes the key', () => {
    expect(locationForRepo('a b', 'x')).toBe('/?repo=a%20b');
  });
  it('control: resolves to the plain origin even from a url with a query string (the bug an empty string caused)', () => {
    expect(new URL(locationForRepo('a', 'a'), 'http://h/?repo=b').href).toBe('http://h/');
  });
});

describe('eventsPathFromWsUrl (RCB-43 slice 3: the ticker backfill follows the socket root)', () => {
  it('the primary socket backfills from /api/events', () => {
    expect(eventsPathFromWsUrl('ws://127.0.0.1:4242/ws')).toBe('/api/events');
  });
  it('a scoped socket backfills from that root, not the primary', () => {
    expect(eventsPathFromWsUrl('ws://127.0.0.1:4242/api/repos/fpj/ws')).toBe(
      '/api/repos/fpj/events',
    );
    expect(eventsPathFromWsUrl('ws://h/api/repos/a%20b/ws')).toBe('/api/repos/a%20b/events');
  });
  it('anything else falls back to the primary (what it meant before)', () => {
    expect(eventsPathFromWsUrl('ws://h/')).toBe('/api/events');
    expect(eventsPathFromWsUrl('not a url')).toBe('/api/events');
  });
});
