/** "just now", "2m ago", "3h ago", "4d ago". Future timestamps (clock skew) read as "just now". */
export function relTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** `claude/web-agent` → `web-agent`; the avatar hashes the full string, the label shows the tail. */
export function shortActor(actor: string): string {
  const tail = actor.split('/').filter(Boolean).pop();
  return tail ?? actor;
}
