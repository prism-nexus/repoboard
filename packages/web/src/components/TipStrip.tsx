/**
 * RCB-149: a one-time dismissible strip on a board with at most 1 card — the only guidance a
 * first-time `repoboard init` + `repoboard serve` user gets on how cards get onto the board.
 * Shown/hidden by `Board.tsx` (`cards.length <= 1 && !tipDismissed`); dismissal persists via
 * `Store.dismissTip()` (`store.ts#STORAGE_TIP`), so it never shows again in this browser.
 */
interface Props {
  onDismiss: () => void;
}

export function TipStrip({ onDismiss }: Props) {
  return (
    <div className="tip-strip" role="note" data-testid="tip-strip">
      <p>
        New board. Add a card from a terminal: <code>repoboard card add "Fix the login bug"</code> —
        or give an agent the board: <code>claude mcp add repoboard -- npx repoboard mcp</code>. Drag
        cards between columns; press / to search.
      </p>
      <button type="button" className="toggle" aria-label="Dismiss tip" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
