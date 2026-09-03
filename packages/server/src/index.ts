// @rcb/server — CLI, HTTP, WebSocket, watcher, scanner, MCP. Filled in from P2.1 onward.
// This stub only proves the workspace link to @rcb/core resolves.
import { defaultBoardConfig } from '@rcb/core';

export const SERVER_NAME = '@rcb/server';

export function defaultPrefix(): string {
  return defaultBoardConfig().prefix;
}
