// @rcb/web — Vite + React + d3 board and repo views. Filled in from P3.1 onward.
// This stub only proves the workspace link to @rcb/core resolves.
import { avatarFor } from '@rcb/core';

export const WEB_NAME = '@rcb/web';

export function avatarLabel(assignee: string): string {
  const { emoji, color } = avatarFor(assignee);
  return `${emoji} ${assignee} (${color})`;
}
