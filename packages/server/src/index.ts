// repoboard — CLI, HTTP, WebSocket, watcher, scanner. MCP arrives in P5.
export { run as runCli } from './cli.js';
export type { RunningServer, ServerOptions } from './http.js';
export { startServer } from './http.js';
export type { RepoPathResult, RepoTextResult } from './refs.js';
export {
  formatResolvedRefs,
  readRepoText,
  resolveCardRefs,
  resolveRefSpec,
  resolveRepoPath,
} from './refs.js';
export type { ScanOptions, ScanResult } from './scanner.js';
export { scanRepo, textFileReason } from './scanner.js';
export type {
  InvalidCard,
  MoveOutcome,
  OpenStoreOptions,
  StoreEvent,
  StoreEvents,
  UpdateOutcome,
} from './store.js';
export { CardStore, compareCardIds, openStore } from './store.js';
export type { DetectRun } from './systems-detect.js';
export { detectSystems, runDetect } from './systems-detect.js';
