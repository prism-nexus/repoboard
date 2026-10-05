/**
 * RCB-218: the store's `seats` and `landings` fields — filled by a snapshot or a message, RESET by a
 * snapshot that lacks them (like `leases`), so a repo switch or a reconnect to an older server never
 * shows another snapshot's seats. Each test names its CONTROL; none was run (the brief forbids any
 * runner), the gating seat watches each fail.
 */
import { describe, expect, it } from 'vitest';
import { testStore } from './helpers.jsx';
import { landingRow, landingsPayload, seatRow, sendSnapshot } from './status-fixtures.js';

describe('store: seats and landings', () => {
  it('start null — nothing has been sent', () => {
    const store = testStore();
    expect(store.getState().seats).toBeNull();
    expect(store.getState().landings).toBeNull();
  });

  // CONTROL: in store.ts drop `seats:`/`landings:` from the snapshot's `set({…})` — both stay null.
  it('a snapshot carries both', () => {
    const store = testStore();
    const seats = [seatRow()];
    const landings = landingsPayload([landingRow('RB-1')]);
    sendSnapshot(store, { seats, landings });
    expect(store.getState().seats).toEqual(seats);
    expect(store.getState().landings).toEqual(landings);
  });

  // CONTROL: in store.ts change `seats: msg.seats ?? null` to `msg.seats ?? state.seats` (and the
  // same for landings) — the second snapshot keeps the first one's values and this fails.
  it('a snapshot WITHOUT them resets both to null, as it does for leases', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow()], landings: landingsPayload([landingRow('RB-1')]) });
    sendSnapshot(store, {});
    expect(store.getState().seats).toBeNull();
    expect(store.getState().landings).toBeNull();
  });

  // CONTROL: in store.ts make `case 'seats'` / `case 'landings'` a no-op — the fields do not change.
  it('a `seats` or `landings` message replaces the field wholesale', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow()], landings: landingsPayload([landingRow('RB-1')]) });
    const seats = [seatRow({ name: 'reviewer', status: 'DOWN', live: null, tag: null })];
    store.dispatch({ type: 'seats', seats });
    expect(store.getState().seats).toEqual(seats);
    const landings = landingsPayload([landingRow('RB-2'), landingRow('RB-1')]);
    store.dispatch({ type: 'landings', landings });
    expect(store.getState().landings).toEqual(landings);
  });
});
