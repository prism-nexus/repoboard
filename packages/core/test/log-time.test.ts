/**
 * RCB-233: `localTitleStamp` (the board's local time at the front of a log title) and
 * `titleTimeWarnings` (a typed clock time in a title that is far from the heading's own stamp).
 * Zone examples are America/Los_Angeles and Europe/Berlin only.
 */
import { describe, expect, it } from 'vitest';
import { isValidTimeZone, localTitleStamp, titleTimeWarnings } from '../src/log-time.js';

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

describe('isValidTimeZone', () => {
  it('knows IANA names and refuses a made-up one', () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone(BERLIN)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('localTitleStamp', () => {
  it('PST, with the local date a day behind the UTC one', () => {
    // 2026-11-01 is the Sunday DST ends in the US (09:00Z), so 04:07Z on the 2nd is PST.
    expect(localTitleStamp('2026-11-02T04:07:05Z', LA)).toBe('8:07 pm PST 11-01');
  });

  it('PDT, the same zone in summer', () => {
    expect(localTitleStamp('2026-07-15T19:05:00Z', LA)).toBe('12:05 pm PDT 07-15');
  });

  it('the DST change itself: one UTC hour apart, the zone name flips', () => {
    expect(localTitleStamp('2026-11-01T08:30:00Z', LA)).toBe('1:30 am PDT 11-01');
    expect(localTitleStamp('2026-11-01T09:30:00Z', LA)).toBe('1:30 am PST 11-01');
  });

  it('local midnight is 12 am and the date is the new local day', () => {
    expect(localTitleStamp('2026-11-02T08:00:00Z', LA)).toBe('12:00 am PST 11-02');
    expect(localTitleStamp('2026-07-15T07:30:00Z', LA)).toBe('12:30 am PDT 07-15');
    expect(localTitleStamp('2026-11-02T07:59:00Z', LA)).toBe('11:59 pm PST 11-01');
  });

  it('a zone ahead of UTC rolls the date forward', () => {
    expect(localTitleStamp('2026-07-15T22:30:00Z', BERLIN)).toMatch(
      /^12:30 am (CEST|GMT\+2) 07-16$/,
    );
  });

  it('is plain ASCII spaces: no narrow no-break space before am/pm', () => {
    expect(localTitleStamp('2026-11-02T04:07:05Z', LA)).not.toMatch(/[  ]/);
  });

  it('a zone it does not know, or a stamp that is not a time, throws', () => {
    expect(() => localTitleStamp('2026-11-02T04:07:05Z', 'Mars/Olympus_Mons')).toThrow(RangeError);
    expect(() => localTitleStamp('not a time', LA)).toThrow(RangeError);
  });
});

describe('titleTimeWarnings: UTC time against the stamp', () => {
  const TS = '2026-11-02T04:07:05Z';

  it('04:30Z at 04:07:05Z warns, naming both times and the gap', () => {
    expect(titleTimeWarnings('stand-up 04:30Z', TS)).toEqual([
      'title time 04:30Z is 23 min from the stamp 04:07:05Z',
    ]);
  });

  it('04:07Z (its minute holds the stamp) and 04:0xZ (its ten minutes do) do not', () => {
    expect(titleTimeWarnings('stand-up 04:07Z', TS)).toEqual([]);
    expect(titleTimeWarnings('stand-up 04:0xZ', TS)).toEqual([]);
    expect(titleTimeWarnings('stand-up 4:07Z', TS)).toEqual([]);
  });

  it('04:3xZ is a ten-minute window, and it is judged from its near edge', () => {
    // The window opens at 04:30:00; the stamp is 22 min 55 s before it.
    expect(titleTimeWarnings('04:3xZ', TS)).toEqual([
      'title time 04:3xZ is 23 min from the stamp 04:07:05Z',
    ]);
  });

  it('within five minutes is fine; a second past five warns (the boundary, both sides)', () => {
    expect(titleTimeWarnings('04:12:05Z', TS)).toEqual([]); // exactly 300 s
    expect(titleTimeWarnings('04:12:06Z', TS)).toEqual([
      'title time 04:12:06Z is 6 min from the stamp 04:07:05Z',
    ]);
    expect(titleTimeWarnings('04:02:05Z', TS)).toEqual([]); // 300 s the other way
    expect(titleTimeWarnings('04:02:04Z', TS)).toEqual([
      'title time 04:02:04Z is 6 min from the stamp 04:07:05Z',
    ]);
  });

  it('is circular over midnight: 23:58Z at 00:01Z is three minutes, not a day', () => {
    expect(titleTimeWarnings('wrap-up 23:58Z', '2026-11-03T00:01:00Z')).toEqual([]);
    expect(titleTimeWarnings('wrap-up 00:03Z', '2026-11-02T23:59:00Z')).toEqual([]);
    // ...and a time that is truly far still warns, by the SHORT way round.
    expect(titleTimeWarnings('wrap-up 23:40Z', '2026-11-03T00:01:00Z')).toEqual([
      'title time 23:40Z is 21 min from the stamp 00:01:00Z',
    ]);
  });

  it('reads only the FIRST UTC time: a later one is a reference, wherever it is', () => {
    expect(titleTimeWarnings('04:07Z picked up the 09:00Z note', TS)).toEqual([]);
    // The first one is the one judged, even when a later one would be fine.
    expect(titleTimeWarnings('09:00Z picked up the 04:07Z note', TS)).toEqual([
      'title time 09:00Z is 293 min from the stamp 04:07:05Z',
    ]);
  });

  it('a time inside a quoted ISO stamp, or inside a longer word, is not a typed time', () => {
    expect(titleTimeWarnings('reread 2026-11-01T09:00:00Z', TS)).toEqual([]);
    expect(titleTimeWarnings('09:00Zulu', TS)).toEqual([]);
    expect(titleTimeWarnings('25:00Z and 09:75Z', TS)).toEqual([]);
  });

  it('no clock time, or a stamp that does not parse, is no warning', () => {
    expect(titleTimeWarnings('landed the thing', TS)).toEqual([]);
    expect(titleTimeWarnings('04:30Z', 'not a time')).toEqual([]);
  });

  it('with no zone given, a local am/pm time is not read at all', () => {
    expect(titleTimeWarnings('9:30 pm', TS)).toEqual([]);
  });
});

describe('titleTimeWarnings: local time against the stamp, only with a zone', () => {
  const TS = '2026-11-02T04:07:05Z'; // 8:07:05 pm PST on 11-01

  it('8:30 pm warns; 8:07 pm, 8:07pm, 8:0x PM and 8:10 pm do not', () => {
    expect(titleTimeWarnings('8:30 pm', TS, LA)).toEqual([
      'title time 8:30 pm is 23 min from the stamp 8:07:05 pm PST',
    ]);
    expect(titleTimeWarnings('8:07 pm', TS, LA)).toEqual([]);
    expect(titleTimeWarnings('8:07pm', TS, LA)).toEqual([]);
    expect(titleTimeWarnings('8:0x PM', TS, LA)).toEqual([]);
    expect(titleTimeWarnings('8:10 pm', TS, LA)).toEqual([]);
  });

  it('am against pm is twelve hours, not a match', () => {
    expect(titleTimeWarnings('8:07 am', TS, LA)).toEqual([
      'title time 8:07 am is 720 min from the stamp 8:07:05 pm PST',
    ]);
  });

  it('12 am / 12 pm mean midnight / noon, and the clock is circular over local midnight', () => {
    expect(titleTimeWarnings('11:58 pm', '2026-11-02T08:01:00Z', LA)).toEqual([]); // 12:01 am
    expect(titleTimeWarnings('12:03 am', '2026-11-02T07:59:00Z', LA)).toEqual([]); // 11:59 pm
    expect(titleTimeWarnings('12:05 pm', '2026-07-15T19:05:00Z', LA)).toEqual([]);
    expect(titleTimeWarnings('12:05 am', '2026-07-15T19:05:00Z', LA)).toHaveLength(1);
  });

  it('reads only the FIRST local time', () => {
    expect(titleTimeWarnings('8:07 pm after the 9:30 pm run', TS, LA)).toEqual([]);
  });

  it('judges a zone ahead of UTC in that zone', () => {
    // 22:30Z on 07-15 is 12:30 am on 07-16 in Berlin.
    expect(titleTimeWarnings('12:31 am', '2026-07-15T22:30:00Z', BERLIN)).toEqual([]);
    expect(titleTimeWarnings('11:30 pm', '2026-07-15T22:30:00Z', BERLIN)).toHaveLength(1);
  });

  it('both forms in one title are each judged against their own clock', () => {
    const title = '9:30 pm PST (04:07Z)'; // local far, UTC right
    expect(titleTimeWarnings(title, TS, LA)).toEqual([
      'title time 9:30 pm is 83 min from the stamp 8:07:05 pm PST',
    ]);
    expect(titleTimeWarnings('8:07 pm PST (04:50Z)', TS, LA)).toEqual([
      'title time 04:50Z is 43 min from the stamp 04:07:05Z',
    ]);
  });
});
