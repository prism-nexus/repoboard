/**
 * RCB-195 (slice A of RCB-194): `holder.ts` — who am I from an env record, how a holder is
 * encoded as one line, the short pane tag and the human label. Pure: every test hands in its own
 * `env` record, never `process.env`.
 */
import { describe, expect, it } from 'vitest';
import {
  checkPaneAssertion,
  DEFAULT_IDENTITY_ENV,
  describeLiveness,
  formatHolder,
  type HolderProbe,
  holderIdentity,
  holderLabel,
  holderLiveness,
  NO_PANE_TAG,
  paneTag,
  parseHolder,
  type SeatHolder,
  type SeatLeaseView,
  sameHolder,
  seatHolderInfos,
  seatMovedText,
  seatWhoami,
} from '../src/holder.js';
import { checkDownFields } from '../src/seat.js';

const MEASURED = { ppid: 4242, host: 'mac-mini', start: 'Tue Sep 29 12:34:56 2026' };

const NO_HOLDER: SeatHolder = { pane: null, session: null, start: null, host: null, pid: null };

describe('DEFAULT_IDENTITY_ENV (RCB-195)', () => {
  it('is iTerm, then Terminal.app, then the Claude session id — in that order', () => {
    expect([...DEFAULT_IDENTITY_ENV]).toEqual([
      'ITERM_SESSION_ID',
      'TERM_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
    ]);
  });
});

describe('holderIdentity: pane (RCB-195)', () => {
  it('ITERM_SESSION_ID wins, and its pane is the part after the LAST colon', () => {
    const id = holderIdentity(
      {
        ITERM_SESSION_ID: 'w1t0p0:A7B21234-AAAA-BBBB',
        TERM_SESSION_ID: 'w9t9p9:OTHER',
        CLAUDE_CODE_SESSION_ID: 'sess-1',
      },
      MEASURED,
    );
    expect(id.pane).toBe('A7B21234-AAAA-BBBB');
  });

  it('only the LAST colon splits — an id that itself contains colons keeps its tail', () => {
    expect(holderIdentity({ ITERM_SESSION_ID: 'w1t0p0:a:b:A7B2' }, MEASURED).pane).toBe('A7B2');
  });

  it('falls back to TERM_SESSION_ID when ITERM_SESSION_ID is absent', () => {
    const id = holderIdentity(
      { TERM_SESSION_ID: 'w0t0p0:1D3F9999', CLAUDE_CODE_SESSION_ID: 'sess-1' },
      MEASURED,
    );
    expect(id.pane).toBe('1D3F9999');
  });

  it('falls back to CLAUDE_CODE_SESSION_ID when neither terminal var is set (owner decision C)', () => {
    const id = holderIdentity({ CLAUDE_CODE_SESSION_ID: 'sess-1' }, MEASURED);
    expect(id.pane).toBe('sess-1');
    expect(id.session).toBe('sess-1');
  });

  it('a value with no colon is the pane itself (Terminal.app gives a bare uuid)', () => {
    expect(holderIdentity({ TERM_SESSION_ID: '1D3F9999-1' }, MEASURED).pane).toBe('1D3F9999-1');
  });

  it('a blank or whitespace-only var is skipped, not taken as an empty pane', () => {
    const id = holderIdentity(
      { ITERM_SESSION_ID: '   ', TERM_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: 'sess-2' },
      MEASURED,
    );
    expect(id.pane).toBe('sess-2');
  });

  it('a value with nothing after its colon names no pane, so that var is skipped too', () => {
    const id = holderIdentity(
      { ITERM_SESSION_ID: 'w1t0p0:', TERM_SESSION_ID: 'w0t0p0:1D3F' },
      MEASURED,
    );
    expect(id.pane).toBe('1D3F');
  });

  it('no identity var at all: pane and session are null — never an empty string', () => {
    const id = holderIdentity({}, MEASURED);
    expect(id.pane).toBeNull();
    expect(id.session).toBeNull();
  });

  it('an override order replaces the default wholesale, including a var the default never names', () => {
    const env = {
      ITERM_SESSION_ID: 'w1t0p0:ITERMPANE',
      TERM_SESSION_ID: 'w0t0p0:TERMPANE',
      MY_PANE: 'x:MINEPANE',
    };
    expect(holderIdentity(env, { ...MEASURED, identityEnv: ['MY_PANE'] }).pane).toBe('MINEPANE');
    expect(
      holderIdentity(env, { ...MEASURED, identityEnv: ['TERM_SESSION_ID', 'ITERM_SESSION_ID'] })
        .pane,
    ).toBe('TERMPANE');
    // The default list is used when the override is absent.
    expect(holderIdentity(env, MEASURED).pane).toBe('ITERMPANE');
  });

  it('an override that finds nothing gives a null pane, never a silent fall back to the defaults', () => {
    const env = { ITERM_SESSION_ID: 'w1t0p0:ITERMPANE' };
    expect(holderIdentity(env, { ...MEASURED, identityEnv: ['NOT_SET'] }).pane).toBeNull();
  });

  it('session is CLAUDE_CODE_SESSION_ID whatever the override says', () => {
    const env = { MY_PANE: 'x:MINEPANE', CLAUDE_CODE_SESSION_ID: '  sess-3  ' };
    const id = holderIdentity(env, { ...MEASURED, identityEnv: ['MY_PANE'] });
    expect(id.pane).toBe('MINEPANE');
    expect(id.session).toBe('sess-3');
  });
});

describe('holderIdentity: pid, host, start (RCB-195)', () => {
  it('CLAUDE_PID wins over the parent pid', () => {
    expect(holderIdentity({ CLAUDE_PID: '777' }, MEASURED).pid).toBe(777);
  });

  it('with no CLAUDE_PID the parent pid stands in', () => {
    expect(holderIdentity({}, MEASURED).pid).toBe(4242);
  });

  it('a CLAUDE_PID that is not a positive integer is ignored, not guessed into one', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '12x', '', '  ']) {
      expect(holderIdentity({ CLAUDE_PID: bad }, MEASURED).pid, bad).toBe(4242);
    }
  });

  it('no CLAUDE_PID and no parent pid: pid is null', () => {
    expect(holderIdentity({}, { ...MEASURED, ppid: null }).pid).toBeNull();
    expect(holderIdentity({ CLAUDE_PID: 'nope' }, { ...MEASURED, ppid: 0 }).pid).toBeNull();
  });

  it('host and start pass through untouched, null included', () => {
    const id = holderIdentity({}, MEASURED);
    expect(id.host).toBe('mac-mini');
    expect(id.start).toBe('Tue Sep 29 12:34:56 2026');
    const none = holderIdentity({}, { ppid: 1, host: null, start: null });
    expect(none.host).toBeNull();
    expect(none.start).toBeNull();
  });
});

describe('formatHolder / parseHolder (RCB-195)', () => {
  const FULL: SeatHolder = {
    pane: 'A7B21234',
    session: 'sess-1',
    start: 'Tue Sep 29 12:34:56 2026',
    host: 'mac-mini',
    pid: 4242,
  };

  it('writes pane, session, pid, start, host — in that fixed order', () => {
    expect(formatHolder(FULL)).toBe(
      'pane=A7B21234;session=sess-1;pid=4242;start=Tue Sep 29 12:34:56 2026;host=mac-mini',
    );
  });

  it('omits a null field, and an all-null holder is the empty string', () => {
    expect(formatHolder({ ...FULL, session: null, start: null })).toBe(
      'pane=A7B21234;pid=4242;host=mac-mini',
    );
    expect(formatHolder(NO_HOLDER)).toBe('');
  });

  it('round-trips a full holder', () => {
    expect(parseHolder(formatHolder(FULL))).toEqual(FULL);
  });

  it('round-trips a holder with nulls, and the empty string is an all-null holder', () => {
    const partial: SeatHolder = { ...NO_HOLDER, pane: 'A7B2', pid: 9 };
    expect(parseHolder(formatHolder(partial))).toEqual(partial);
    expect(parseHolder('')).toEqual(NO_HOLDER);
  });

  it('a `;`, `=` or `%` inside a value is percent-encoded and survives the round trip', () => {
    const awkward: SeatHolder = { ...FULL, host: 'a;b=c%d', session: 'x;y', pane: '%3B' };
    const line = formatHolder(awkward);
    expect(line).toBe(
      'pane=%253B;session=x%3By;pid=4242;start=Tue Sep 29 12:34:56 2026;host=a%3Bb%3Dc%25d',
    );
    // One `;` per field boundary — the encoded values add none.
    expect(line.split(';')).toHaveLength(5);
    expect(parseHolder(line)).toEqual(awkward);
  });

  it('decoding is one pass: the text `%3B` is not turned into `;`', () => {
    expect(parseHolder('pane=%253B').pane).toBe('%3B');
  });

  it('an absent key is null; unknown keys and segments without `=` are ignored', () => {
    expect(parseHolder('pane=A7B2;future=1;stray;pid=12')).toEqual({
      ...NO_HOLDER,
      pane: 'A7B2',
      pid: 12,
    });
  });

  it('a bad pid is null; an empty value is null', () => {
    for (const bad of ['abc', '0', '-1', '1.5', '']) {
      expect(parseHolder(`pane=A7B2;pid=${bad}`).pid, bad).toBeNull();
    }
    expect(parseHolder('pane=;host=h').pane).toBeNull();
  });

  it('never throws on garbage', () => {
    expect(parseHolder(';;;===;%%;=')).toEqual(NO_HOLDER);
  });
});

describe('paneTag / holderLabel (RCB-195)', () => {
  it('is the first 4 characters, uppercased', () => {
    expect(paneTag('a7b21234-aaaa', [])).toBe('A7B2');
  });

  it('widens to 6 when another DIFFERENT pane shares those 4', () => {
    expect(paneTag('a7b21234-aaaa', ['A7B2FFFF-bbbb'])).toBe('A7B212');
    expect(paneTag('A7B2FFFF-bbbb', ['a7b21234-aaaa'])).toBe('A7B2FF');
  });

  it('does not widen for the SAME pane — even listed among the others, even in another letter case', () => {
    expect(paneTag('a7b21234-aaaa', ['a7b21234-aaaa'])).toBe('A7B2');
    expect(paneTag('a7b21234-aaaa', ['A7B21234-AAAA'])).toBe('A7B2');
  });

  it('does not widen for a pane that differs inside the first 4', () => {
    expect(paneTag('a7b21234', ['b7b21234', 'a8b21234', '1D3F9999'])).toBe('A7B2');
  });

  it('widens when ANY one of several others collides', () => {
    expect(paneTag('a7b21234', ['1D3F9999', 'A7B2FFFF', 'A1B2C3D4'])).toBe('A7B212');
  });

  it('a pane shorter than the tag is used whole', () => {
    expect(paneTag('ab', [])).toBe('AB');
    expect(paneTag('ab', ['ABCD'])).toBe('AB');
  });

  it('holderLabel is `<tag> · <shortName> <seat>`', () => {
    expect(holderLabel('1D3F', 'rcb', 'builder')).toBe('1D3F · rcb builder');
    expect(holderLabel('A7B212', 'acme', 'ops')).toBe('A7B212 · acme ops');
  });
});

describe('CONTROL: a pane is what tells two seats apart (RCB-195)', () => {
  /** env -> identity -> tag -> label, exactly the chain slice B will run at the CLI entry. */
  const labelFor = (env: Record<string, string>): string => {
    const id = holderIdentity(env, MEASURED);
    return holderLabel(paneTag(id.pane ?? '', []), 'rcb', 'builder');
  };

  it('two different ITERM_SESSION_IDs give two different labels', () => {
    const a = labelFor({ ITERM_SESSION_ID: 'w1t0p0:A7B21111-2222' });
    const b = labelFor({ ITERM_SESSION_ID: 'w1t0p1:1D3F3333-4444' });
    expect(a).toBe('A7B2 · rcb builder');
    expect(b).toBe('1D3F · rcb builder');
    expect(a).not.toBe(b);
  });

  it('the SAME pane in a later process (new pid, new session) keeps the same label', () => {
    const before = holderIdentity(
      { ITERM_SESSION_ID: 'w1t0p0:A7B21111-2222', CLAUDE_CODE_SESSION_ID: 'sess-1' },
      MEASURED,
    );
    const after = holderIdentity(
      { ITERM_SESSION_ID: 'w1t0p0:A7B21111-2222', CLAUDE_CODE_SESSION_ID: 'sess-2' },
      { ...MEASURED, ppid: 9999 },
    );
    expect(after.pane).toBe(before.pane);
    expect(after.session).not.toBe(before.session);
    expect(after.pid).not.toBe(before.pid);
  });
});

const STARTED = 'Tue Sep 29 12:34:56 2026';

/** A recorded holder as `seats.yml` would hold it: pane, pid, start and host all known. */
const RECORDED: SeatHolder = {
  pane: 'A7B21234-AAAA',
  session: 'sess-1',
  start: STARTED,
  host: 'mac-mini',
  pid: 4242,
};

/** What a probe of that pid finds when the holder is exactly as recorded. */
const PROBE_ALIVE: HolderProbe = { host: 'mac-mini', signal: 'alive', start: STARTED };

describe('holderLiveness (RCB-197)', () => {
  it('alive: same host, the pid answers, the start time matches', () => {
    expect(holderLiveness(RECORDED, PROBE_ALIVE)).toEqual({ state: 'alive' });
  });

  it('EPERM counts as alive — the process exists, it is only not ours to signal', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, signal: 'eperm' })).toEqual({
      state: 'alive',
    });
  });

  it('hosts are compared case-insensitively', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, host: 'MAC-Mini' })).toEqual({
      state: 'alive',
    });
  });

  it('unknown other-host: a different host', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, host: 'laptop' })).toEqual({
      state: 'unknown',
      reason: 'other-host',
    });
  });

  it('unknown other-host: the recorded host is null', () => {
    expect(holderLiveness({ ...RECORDED, host: null }, PROBE_ALIVE)).toEqual({
      state: 'unknown',
      reason: 'other-host',
    });
  });

  it('unknown other-host: this host is null', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, host: null })).toEqual({
      state: 'unknown',
      reason: 'other-host',
    });
  });

  it('the host rule comes first: another host is other-host even when the signal says esrch', () => {
    expect(holderLiveness(RECORDED, { host: 'laptop', signal: 'esrch', start: null })).toEqual({
      state: 'unknown',
      reason: 'other-host',
    });
  });

  it('unknown no-pid: nothing was recorded to probe — even when the signal says esrch', () => {
    expect(holderLiveness({ ...RECORDED, pid: null }, PROBE_ALIVE)).toEqual({
      state: 'unknown',
      reason: 'no-pid',
    });
    expect(holderLiveness({ ...RECORDED, pid: null }, { ...PROBE_ALIVE, signal: 'esrch' })).toEqual(
      {
        state: 'unknown',
        reason: 'no-pid',
      },
    );
  });

  it('dead no-process: esrch — even with no start time on either side', () => {
    expect(holderLiveness(RECORDED, { host: 'mac-mini', signal: 'esrch', start: null })).toEqual({
      state: 'dead',
      reason: 'no-process',
    });
    expect(
      holderLiveness(
        { ...RECORDED, start: null },
        { host: 'mac-mini', signal: 'esrch', start: null },
      ),
    ).toEqual({ state: 'dead', reason: 'no-process' });
  });

  it('unknown no-signal: the pid was not probed', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, signal: null })).toEqual({
      state: 'unknown',
      reason: 'no-signal',
    });
  });

  it('unknown no-start: the recorded start time is null — a live pid alone is not the holder', () => {
    expect(holderLiveness({ ...RECORDED, start: null }, PROBE_ALIVE)).toEqual({
      state: 'unknown',
      reason: 'no-start',
    });
  });

  it('unknown no-start: the probe measured no start time', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, start: null })).toEqual({
      state: 'unknown',
      reason: 'no-start',
    });
  });

  it('GUARD (start check): a live pid with a DIFFERENT start time is a recycled pid — dead pid-reused', () => {
    expect(holderLiveness(RECORDED, { ...PROBE_ALIVE, start: 'Wed Sep 30 01:00:00 2026' })).toEqual(
      { state: 'dead', reason: 'pid-reused' },
    );
    expect(
      holderLiveness(RECORDED, {
        ...PROBE_ALIVE,
        signal: 'eperm',
        start: 'Wed Sep 30 01:00:00 2026',
      }),
    ).toEqual({ state: 'dead', reason: 'pid-reused' });
  });
});

describe('describeLiveness (RCB-197)', () => {
  it('words every state and reason once', () => {
    expect(describeLiveness({ state: 'alive' })).toBe('alive');
    expect(describeLiveness({ state: 'dead', reason: 'no-process' })).toBe('dead: no process');
    expect(describeLiveness({ state: 'dead', reason: 'pid-reused' })).toBe('dead: pid reused');
    expect(describeLiveness({ state: 'unknown', reason: 'other-host' })).toBe(
      'unknown: other host',
    );
    expect(describeLiveness({ state: 'unknown', reason: 'no-pid' })).toBe('unknown: no pid');
    expect(describeLiveness({ state: 'unknown', reason: 'no-signal' })).toBe('unknown: no signal');
    expect(describeLiveness({ state: 'unknown', reason: 'no-start' })).toBe('unknown: no start');
  });
});

describe('sameHolder (RCB-197)', () => {
  it('the same pane is the same holder — a new session and a new pid after /clear', () => {
    expect(
      sameHolder(RECORDED, { ...RECORDED, session: 'sess-2', pid: 9999, start: 'later' }),
    ).toBe(true);
  });

  it('panes are compared case-insensitively', () => {
    expect(
      sameHolder(RECORDED, { ...RECORDED, pane: 'a7b21234-aaaa', pid: 1, host: 'other' }),
    ).toBe(true);
  });

  it('different panes, different pids: not the same holder', () => {
    expect(sameHolder(RECORDED, { ...RECORDED, pane: '1D3F9999', pid: 9999 })).toBe(false);
  });

  it('no pane (session-id fallback changed on /clear): same host + same pid + same start is the same holder', () => {
    const before: SeatHolder = { ...RECORDED, pane: 'sess-1' };
    const after: SeatHolder = { ...RECORDED, pane: 'sess-2' };
    expect(sameHolder(before, after)).toBe(true);
    expect(sameHolder({ ...RECORDED, pane: null }, { ...RECORDED, pane: null })).toBe(true);
  });

  it('hosts are compared case-insensitively on the pid clause', () => {
    expect(
      sameHolder({ ...RECORDED, pane: null }, { ...RECORDED, pane: null, host: 'MAC-MINI' }),
    ).toBe(true);
  });

  it('GUARD (start check): the same pid with a DIFFERENT start time is a recycled pid — not the same holder', () => {
    expect(
      sameHolder(
        { ...RECORDED, pane: null },
        { ...RECORDED, pane: null, start: 'Wed Sep 30 01:00:00 2026' },
      ),
    ).toBe(false);
  });

  it('GUARD (strict start): two NULL start times are NOT the same holder — a pid with nothing to check it against is a guess', () => {
    const noStart: SeatHolder = { ...RECORDED, pane: null, start: null };
    expect(sameHolder(noStart, { ...noStart })).toBe(false);
    expect(sameHolder(noStart, { ...noStart, start: STARTED })).toBe(false);
    expect(sameHolder({ ...noStart, start: STARTED }, noStart)).toBe(false);
  });

  it('the same pid on a different host is not the same holder', () => {
    expect(
      sameHolder({ ...RECORDED, pane: null }, { ...RECORDED, pane: null, host: 'laptop' }),
    ).toBe(false);
  });

  it('a null host or a null pid on either side never matches on the pid clause', () => {
    const a: SeatHolder = { ...RECORDED, pane: null };
    expect(sameHolder(a, { ...a, host: null })).toBe(false);
    expect(sameHolder({ ...a, host: null }, a)).toBe(false);
    expect(sameHolder({ ...a, host: null }, { ...a, host: null })).toBe(false);
    expect(sameHolder(a, { ...a, pid: null })).toBe(false);
    expect(sameHolder({ ...a, pid: null }, { ...a, pid: null })).toBe(false);
  });

  it('a null pane on one side does not match a known pane; the pid clause decides', () => {
    expect(sameHolder(RECORDED, { ...RECORDED, pane: null, pid: 9999 })).toBe(false);
    expect(sameHolder(RECORDED, { ...RECORDED, pane: null })).toBe(true);
  });

  it('a holder with nothing known is not the same as another such holder', () => {
    expect(sameHolder(NO_HOLDER, NO_HOLDER)).toBe(false);
  });
});

describe('checkPaneAssertion (RCB-197)', () => {
  const PANE = 'A7B21234-AAAA-BBBB';

  it('4 characters that prefix the pane: ok', () => {
    expect(checkPaneAssertion(PANE, 'A7B2')).toBeNull();
  });

  it('6 characters that prefix the pane: ok', () => {
    expect(checkPaneAssertion(PANE, 'A7B212')).toBeNull();
  });

  it('case-insensitive both ways', () => {
    expect(checkPaneAssertion(PANE, 'a7b2')).toBeNull();
    expect(checkPaneAssertion('a7b21234-aaaa', 'A7B2')).toBeNull();
    expect(checkPaneAssertion(PANE, 'a7b212')).toBeNull();
  });

  it('5 characters is refused, and the error quotes what was given', () => {
    expect(checkPaneAssertion(PANE, 'A7B21')).toContain('"A7B21"');
    expect(checkPaneAssertion(PANE, 'A7B21')).not.toBeNull();
  });

  it('3, 7 and 0 characters are refused', () => {
    expect(checkPaneAssertion(PANE, 'C71')).not.toBeNull();
    expect(checkPaneAssertion(PANE, 'A7B2123')).not.toBeNull();
    expect(checkPaneAssertion(PANE, '')).not.toBeNull();
  });

  it('whitespace anywhere in the assertion is refused', () => {
    expect(checkPaneAssertion(PANE, ' A7B2')).not.toBeNull();
    expect(checkPaneAssertion(PANE, 'C7 6')).not.toBeNull();
    expect(checkPaneAssertion(PANE, 'A7B2 ')).not.toBeNull();
  });

  it('a null pane is refused — nothing to assert against', () => {
    expect(checkPaneAssertion(null, 'A7B2')).not.toBeNull();
    expect(checkPaneAssertion(null, 'A7B2')).toContain('A7B2');
  });

  it('a mismatch names both the assertion and this pane', () => {
    const err = checkPaneAssertion(PANE, '1D3F');
    expect(err).toContain('1D3F');
    expect(err).toContain('A7B2');
  });

  it('a 6-character assertion that only matches its first 4 is a mismatch', () => {
    expect(checkPaneAssertion(PANE, 'A7B2FF')).not.toBeNull();
  });

  it('an assertion longer than the pane id is a mismatch', () => {
    expect(checkPaneAssertion('ab12', 'ab12cd')).not.toBeNull();
  });

  it('RCB-207: youAre ends the MISMATCH refusal with "; you are <label>", and only that one', () => {
    const label = 'A7B2 · acme builder';
    expect(checkPaneAssertion(PANE, '1D3F', label)).toBe(
      `seat: --pane 1D3F does not match this pane (A7B2); you are ${label}`,
    );
    // without it the text is what it always was
    expect(checkPaneAssertion(PANE, '1D3F')).toBe(
      'seat: --pane 1D3F does not match this pane (A7B2)',
    );
    // the other two refusals, and the ok verdict, are not reworded or flipped by a label
    expect(checkPaneAssertion(PANE, 'C71', label)).toBe(checkPaneAssertion(PANE, 'C71'));
    expect(checkPaneAssertion(null, 'A7B2', label)).toBe(checkPaneAssertion(null, 'A7B2'));
    expect(checkPaneAssertion(PANE, 'A7B2', label)).toBeNull();
  });
});

describe('seatMovedText (RCB-197)', () => {
  it('says the seat moved, and points both fields at the new seat', () => {
    expect(seatMovedText('builder')).toBe(
      'moved to builder in the same pane\nin-flight: see builder\nowes: see builder',
    );
  });

  it('passes checkDownFields — a --from stand-down needs no hand-typed fields', () => {
    expect(checkDownFields(seatMovedText('builder'))).toBeNull();
  });
});

/** RCB-199: a recorded `seat:<name>` lease as the store reads it — `pane` may be `null`. */
function view(
  seat: string,
  pane: string | null,
  state: 'alive' | 'dead' | 'unknown' = 'alive',
  extra: Partial<SeatHolder> = {},
): SeatLeaseView {
  return {
    seat,
    holder: { pane, session: null, start: STARTED, host: 'mac-mini', pid: 4242, ...extra },
    since: '2026-09-29T12:00:00Z',
    liveness:
      state === 'alive'
        ? { state: 'alive' }
        : state === 'dead'
          ? { state: 'dead', reason: 'no-process' }
          : { state: 'unknown', reason: 'other-host' },
  };
}

/** RCB-199: the asking process — a holder as `holderIdentity` would build it for `pane`. */
function me(pane: string | null, extra: Partial<SeatHolder> = {}): SeatHolder {
  return { pane, session: 'sess-me', start: STARTED, host: 'mac-mini', pid: 5151, ...extra };
}

describe('NO_PANE_TAG (RCB-199)', () => {
  it('is the exact text a holder with no pane is shown by', () => {
    expect(NO_PANE_TAG).toBe('(no pane)');
  });
});

describe('seatHolderInfos (RCB-199)', () => {
  it('same order as the views; tag and label per view, the view itself kept whole', () => {
    const views = [view('builder', 'A7B21234-AAAA'), view('coordinator', '1D3F9999-BBBB')];
    const infos = seatHolderInfos(views, 'rcb');
    expect(infos.map((i) => i.seat)).toEqual(['builder', 'coordinator']);
    expect(infos.map((i) => i.tag)).toEqual(['A7B2', '1D3F']);
    expect(infos.map((i) => i.label)).toEqual(['A7B2 · rcb builder', '1D3F · rcb coordinator']);
    expect(infos[0]).toMatchObject(views[0] ?? {});
  });

  it('a holder with no pane has tag null and label null, never a guessed tag', () => {
    const [info] = seatHolderInfos([view('ops', null)], 'rcb');
    expect(info?.tag).toBeNull();
    expect(info?.label).toBeNull();
  });

  it('a pane-less view never widens anyone', () => {
    const infos = seatHolderInfos([view('builder', 'A7B21234'), view('ops', null)], 'rcb');
    expect(infos.map((i) => i.tag)).toEqual(['A7B2', null]);
  });

  it('two live panes sharing their first 4 characters are BOTH widened to 6', () => {
    const infos = seatHolderInfos([view('builder', 'A7B2AA11'), view('ops', 'A7B2BB22')], 'rcb');
    expect(infos.map((i) => i.tag)).toEqual(['A7B2AA', 'A7B2BB']);
    expect(infos.map((i) => i.label)).toEqual(['A7B2AA · rcb builder', 'A7B2BB · rcb ops']);
  });

  it('a DEAD view never widens the live one; the live one still widens the dead one', () => {
    const infos = seatHolderInfos(
      [view('builder', 'A7B2AA11'), view('ops', 'A7B2BB22', 'dead')],
      'rcb',
    );
    expect(infos[0]?.tag).toBe('A7B2');
    // Only the dead view's OWN tag is computed against the live one (the rule is about who widens).
    expect(infos[1]?.tag).toBe('A7B2BB');
  });

  it('an UNKNOWN view still widens — only a measured-dead holder is set aside', () => {
    const infos = seatHolderInfos(
      [view('builder', 'A7B2AA11'), view('ops', 'A7B2BB22', 'unknown')],
      'rcb',
    );
    expect(infos.map((i) => i.tag)).toEqual(['A7B2AA', 'A7B2BB']);
  });

  it('two views on the same pane (any letter case) are one pane, not a collision', () => {
    const infos = seatHolderInfos([view('builder', 'a7b21234'), view('ops', 'A7B21234')], 'rcb');
    expect(infos.map((i) => i.tag)).toEqual(['A7B2', 'A7B2']);
  });

  it('no views -> no infos', () => {
    expect(seatHolderInfos([], 'rcb')).toEqual([]);
  });
});

describe('seatWhoami (RCB-199)', () => {
  const views = [view('builder', 'A7B21234-AAAA'), view('coordinator', '1D3F9999-BBBB')];

  it('two panes get two different labels, each naming its own seat', () => {
    const first = seatWhoami(me('A7B21234-AAAA'), views, 'rcb');
    const second = seatWhoami(me('1D3F9999-BBBB'), views, 'rcb');
    expect(first).toEqual({
      tag: 'A7B2',
      seat: 'builder',
      alsoHolds: [],
      label: 'A7B2 · rcb builder',
    });
    expect(second).toEqual({
      tag: '1D3F',
      seat: 'coordinator',
      alsoHolds: [],
      label: '1D3F · rcb coordinator',
    });
  });

  it('a pane after /clear (new session, same pane) is still the holder', () => {
    const cleared = me('a7b21234-aaaa', { session: 'sess-after-clear', pid: 7777 });
    expect(seatWhoami(cleared, views, 'rcb').seat).toBe('builder');
  });

  it('no lease for this pane -> "<tag> · no seat", seat null, holds nothing else', () => {
    expect(seatWhoami(me('FFFF0000'), views, 'rcb')).toEqual({
      tag: 'FFFF',
      seat: null,
      alsoHolds: [],
      label: 'FFFF · no seat',
    });
  });

  it('no leases at all -> "<tag> · no seat"', () => {
    expect(seatWhoami(me('A7B21234'), [], 'rcb').label).toBe('A7B2 · no seat');
  });

  it('a DEAD view never widens the tag', () => {
    const held = [view('builder', 'A7B2AA11'), view('ops', 'A7B2BB22', 'dead')];
    expect(seatWhoami(me('A7B2AA11'), held, 'rcb').tag).toBe('A7B2');
  });

  it('CONTROL: the same view alive DOES widen it — the dead case above is not vacuous', () => {
    const held = [view('builder', 'A7B2AA11'), view('ops', 'A7B2BB22', 'alive')];
    expect(seatWhoami(me('A7B2AA11'), held, 'rcb')).toMatchObject({
      tag: 'A7B2AA',
      label: 'A7B2AA · rcb builder',
    });
  });

  it('a pane with no lease widens against live panes it collides with', () => {
    const held = [view('builder', 'A7B2AA11')];
    expect(seatWhoami(me('A7B2BB22'), held, 'rcb').label).toBe('A7B2BB · no seat');
  });

  it('holding two seats: seat is the first in file order, alsoHolds the rest', () => {
    const held = [
      view('ops', 'A7B21234'),
      view('coordinator', '1D3F9999'),
      view('builder', 'A7B21234'),
      view('review', 'A7B21234'),
    ];
    expect(seatWhoami(me('A7B21234'), held, 'rcb')).toEqual({
      tag: 'A7B2',
      seat: 'ops',
      alsoHolds: ['builder', 'review'],
      label: 'A7B2 · rcb ops',
    });
  });

  it('liveness is ignored when deciding what is held — a dead record of my own pane still counts', () => {
    const held = [view('builder', 'A7B21234', 'dead'), view('ops', 'A7B21234', 'unknown')];
    const who = seatWhoami(me('A7B21234'), held, 'rcb');
    expect(who.seat).toBe('builder');
    expect(who.alsoHolds).toEqual(['ops']);
  });

  it('no pane -> tag "(no pane)" and "(no pane) · no seat"', () => {
    expect(seatWhoami(me(null), views, 'rcb')).toEqual({
      tag: '(no pane)',
      seat: null,
      alsoHolds: [],
      label: '(no pane) · no seat',
    });
  });

  it('no pane but the same host + pid + start as a lease -> that seat, labelled "(no pane) · …"', () => {
    const held = [view('builder', null, 'alive', { pid: 5151 })];
    expect(seatWhoami(me(null), held, 'rcb')).toEqual({
      tag: '(no pane)',
      seat: 'builder',
      alsoHolds: [],
      label: '(no pane) · rcb builder',
    });
  });

  it('a null pane never matches a lease by pane — two pane-less holders with different pids differ', () => {
    const held = [view('builder', null, 'alive', { pid: 9999 })];
    expect(seatWhoami(me(null), held, 'rcb').seat).toBeNull();
  });
});
