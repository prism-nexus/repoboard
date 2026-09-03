/** ISO-8601 UTC without milliseconds, matching the examples in BUILD-PLAN §2. */
export function toIso(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error('toIso: invalid Date');
  }
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
