import type { ResolvedRef } from '@repoboard/core';
import { renderMarkdown } from '../markdown.js';

/**
 * K7 (extracted RCB-98): renders one resolved ref span (or its unresolved error) — the shape the
 * card drawer's References section and the Flow view's system drawer both fetch from an
 * `/api/.../refs` endpoint and want rendered identically.
 */
function refRange(r: ResolvedRef): string {
  if (r.start === null || r.end === null) return r.spec;
  const range = r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
  return `${r.path ?? r.spec}:${range}`;
}

function Reference({ r }: { r: ResolvedRef }) {
  if (r.text === null) {
    return (
      <div className="drawer__ref drawer__ref--error" data-testid="ref-error">
        <div className="drawer__ref-head mono">{r.spec}</div>
        <div className="drawer__ref-error">{r.error ?? 'unresolved'}</div>
      </div>
    );
  }
  const isMarkdown = /\.(md|markdown)$/i.test(r.path ?? '');
  return (
    <div className="drawer__ref" data-testid="ref">
      <div className="drawer__ref-head mono">
        {refRange(r)}
        {r.truncated ? <span className="muted"> (truncated)</span> : null}
      </div>
      {isMarkdown ? (
        <div
          className="prose drawer__ref-body"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }}
        />
      ) : (
        <pre className="drawer__ref-body mono">{r.text}</pre>
      )}
    </div>
  );
}

/** A resolved `ResolvedRef[]`, rendered one `Reference` block per entry — the loading/error
 * wrapper around a fetch is the caller's job (`Drawer.tsx`'s `References`, `views/Flow.tsx`). */
export function RefsList({ refs }: { refs: ResolvedRef[] }) {
  return (
    <>
      {refs.map((r, i) => (
        <Reference key={`${r.spec}-${i.toString()}`} r={r} />
      ))}
    </>
  );
}
