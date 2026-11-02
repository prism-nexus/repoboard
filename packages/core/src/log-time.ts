/**
 * RCB-233: the board's local clock in a log title, and the check that a TYPED clock time in a
 * title is close to the heading's own stamp.
 *
 * Seats used to type `8:07 pm PST 11-01 (04:07Z 11-02): …` into every log title by hand although
 * the heading already carries the tool's ISO stamp; on one member board most corrections to a log
 * were a wrong typed time. `localTitleStamp` lets the tool write the local time itself (with
 * `board.yml`'s `timezone:`), and `titleTimeWarnings` says so when a time that is still typed is
 * far from the stamp. Pure: `Intl` is a global, not an import (§0.5), and nothing here reads a
 * clock — the caller hands in the stamp.
 */

const DAY_SECONDS = 86_400;

/** A typed time further than this from the stamp is reported. 5 minutes, per the card. */
const TOLERANCE_SECONDS = 5 * 60;

/** `true` when this runtime knows `tz` as a time zone (the check `Intl.DateTimeFormat` itself makes). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedClock {
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
  /** `MM`, `DD` (two digits) in the zone. */
  month: string;
  day: string;
  /** The zone's short name for that instant: `PST`, `PDT`, `GMT+1`. */
  zone: string;
}

function parseStamp(ts: string): Date | null {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedClock(date: Date, tz: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    // Some engines spell midnight `24` even under h23; `% 24` makes it 0 whichever they do.
    hour: Number.parseInt(get('hour'), 10) % 24,
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    month: get('month'),
    day: get('day'),
    zone: get('timeZoneName'),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `{ h12, period }` for a 0-23 hour: 0 -> `12 am`, 12 -> `12 pm`, 20 -> `8 pm`. */
function twelveHour(hour: number): { h12: number; period: 'am' | 'pm' } {
  return { h12: hour % 12 === 0 ? 12 : hour % 12, period: hour < 12 ? 'am' : 'pm' };
}

/**
 * The board's local time at `ts` (an ISO-8601 instant) in `tz` (an IANA zone name), as the front of
 * a log title: `8:07 pm PST 11-01` — hour without a leading zero, two-digit minute, lowercase
 * am/pm, the zone's short name, then `MM-DD` in that zone. `tz` must be valid (`isValidTimeZone`)
 * and `ts` parseable; either failing throws a `RangeError`, because a caller that got past
 * `parseBoard` and `toIso` has neither problem and a silent wrong stamp is the failure this card
 * exists to remove. Built from `formatToParts` pieces, never from a formatted string, so the
 * narrow no-break space newer ICU puts before `PM` cannot reach a heading.
 */
export function localTitleStamp(ts: string, tz: string): string {
  const date = parseStamp(ts);
  if (date === null) throw new RangeError(`localTitleStamp: not a timestamp: ${ts}`);
  const clock = zonedClock(date, tz);
  const { h12, period } = twelveHour(clock.hour);
  return `${h12}:${pad2(clock.minute)} ${period} ${clock.zone} ${clock.month}-${clock.day}`;
}

/**
 * A typed UTC time: `H:MM[:SS]Z` or `H:MxZ` (`x` = "that ten-minute window", a redaction seats
 * already write). Not inside a longer token (`T04:07:05Z` in a quoted ISO stamp is a reference,
 * not a typed time) and not followed by more word (`04:07Zulu`). Group 1 hour; 2 minute, 3 second
 * (full forms); 4 the minute's tens digit (`x` form).
 */
const UTC_TIME = /(?<![\w:])(2[0-3]|[01]?\d):(?:([0-5]\d)(?::([0-5]\d))?|([0-5])x)Z(?![A-Za-z0-9])/;

/**
 * A typed local time: `h:mm am|pm` or `h:mx am|pm`, the space optional, case ignored. Group 1 hour
 * (1-12); 2 minute (full form); 3 the tens digit (`x` form); 4 am/pm.
 */
const LOCAL_TIME = /(?<![\w:])(1[0-2]|0?[1-9]):(?:([0-5]\d)|([0-5])x)\s?([ap]m)(?![A-Za-z])/i;

/**
 * Seconds from `nowSec` to the nearest second of the window `[startSec, startSec + lenSec)`, on a
 * clock that wraps at midnight: 23:58 and 00:01 are three minutes apart, not twenty-three hours.
 * 0 when `nowSec` is inside the window.
 */
function windowDistance(startSec: number, lenSec: number, nowSec: number): number {
  const sinceStart = (((nowSec - startSec) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  if (sinceStart < lenSec) return 0;
  return Math.min(sinceStart - (lenSec - 1), DAY_SECONDS - sinceStart);
}

/** Whole minutes, rounded UP, so a warning always names a number above the tolerance. */
const minutesOf = (seconds: number): number => Math.ceil(seconds / 60);

/**
 * Warnings for a TYPED clock time in `title` that is more than 5 minutes from the heading's own
 * stamp `ts` — one line each, empty when all is well.
 *
 * - UTC: the FIRST `H:MM[:SS]Z` or `H:MxZ` in the title against `ts`'s UTC time. `H:MM` covers its
 *   whole minute and `H:MxZ` its whole ten-minute window, so `04:07Z` and `04:0xZ` agree with a
 *   stamp of 04:07:05Z; a point time (`:SS`) is exact. Circular over midnight.
 *   `title time 04:30Z is 23 min from the stamp 04:07:05Z`
 * - Local, only when `tz` is given: the FIRST `h:mm am|pm` or `h:mx am|pm` against `ts` in `tz`.
 *   `title time 8:30 pm is 23 min from the stamp 8:07:05 pm PST`
 *
 * Only the first of each form is read — a later one is a reference to some other moment (a card's
 * deadline, an earlier run), not the time of this entry. A `ts` that does not parse yields no
 * warnings: there is nothing to compare against. The caller passes the title as TYPED, before any
 * local-time prefix is added, or the prefix would be compared with itself.
 */
export function titleTimeWarnings(title: string, ts: string, tz?: string): string[] {
  const date = parseStamp(ts);
  if (date === null) return [];
  const warnings: string[] = [];

  const utc = UTC_TIME.exec(title);
  if (utc) {
    const hour = Number.parseInt(utc[1] ?? '0', 10);
    let startSec: number;
    let lenSec: number;
    if (utc[4] !== undefined) {
      startSec = hour * 3600 + Number.parseInt(utc[4], 10) * 600;
      lenSec = 600;
    } else if (utc[3] !== undefined) {
      startSec =
        hour * 3600 + Number.parseInt(utc[2] ?? '0', 10) * 60 + Number.parseInt(utc[3], 10);
      lenSec = 1;
    } else {
      startSec = hour * 3600 + Number.parseInt(utc[2] ?? '0', 10) * 60;
      lenSec = 60;
    }
    const nowSec = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
    const distance = windowDistance(startSec, lenSec, nowSec);
    if (distance > TOLERANCE_SECONDS) {
      const stamp = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}Z`;
      warnings.push(`title time ${utc[0]} is ${minutesOf(distance)} min from the stamp ${stamp}`);
    }
  }

  if (tz !== undefined) {
    const local = LOCAL_TIME.exec(title);
    if (local) {
      const typed = Number.parseInt(local[1] ?? '12', 10);
      const hour = (typed % 12) + (local[4]?.toLowerCase() === 'pm' ? 12 : 0);
      let startSec: number;
      let lenSec: number;
      if (local[3] !== undefined) {
        startSec = hour * 3600 + Number.parseInt(local[3], 10) * 600;
        lenSec = 600;
      } else {
        startSec = hour * 3600 + Number.parseInt(local[2] ?? '0', 10) * 60;
        lenSec = 60;
      }
      const clock = zonedClock(date, tz);
      const nowSec = clock.hour * 3600 + clock.minute * 60 + clock.second;
      const distance = windowDistance(startSec, lenSec, nowSec);
      if (distance > TOLERANCE_SECONDS) {
        const { h12, period } = twelveHour(clock.hour);
        const stamp = `${h12}:${pad2(clock.minute)}:${pad2(clock.second)} ${period} ${clock.zone}`;
        warnings.push(
          `title time ${local[0]} is ${minutesOf(distance)} min from the stamp ${stamp}`,
        );
      }
    }
  }

  return warnings;
}
