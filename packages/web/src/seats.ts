/**
 * RCB-85: parses the STATE.md `## SEATS` section into a live-preview strip. `seat --up/--down`
 * (cli.ts `restamped SEATS`) writes lines like:
 *   - **repoboard builder: UP 2026-09-21 18:01Z.** …
 * and, hand-written on the fpj board, with an unknown digit as `x`:
 *   - **coordinator: DOWN 2026-09-21 18:0xZ (11:0x Pacific)** …
 * Other bullets in the same section (e.g. `- Owner tasks elsewhere: …`) don't start with
 * `- **name: UP|DOWN` and are ignored. A seat line whose date/time suffix is missing or
 * malformed still counts as a seat — `iso` is `null` rather than a plausible-but-wrong guess.
 */
export type Seat = { name: string; status: 'UP' | 'DOWN'; iso: string | null };

const SEAT_LINE = /^- \*\*(.+?): (UP|DOWN)(?: (\d{4}-\d{2}-\d{2}) (\d{2}):(\d[\dx]))?/gm;

export function parseSeats(body: string): Seat[] {
  const seats: Seat[] = [];
  for (const m of body.matchAll(SEAT_LINE)) {
    const [, name, status, date, hh, mm] = m;
    const iso = date && hh && mm ? `${date}T${hh}:${mm.replace('x', '0')}:00Z` : null;
    seats.push({ name: name as string, status: status as 'UP' | 'DOWN', iso });
  }
  return seats;
}
