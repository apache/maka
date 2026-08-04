// Workspace-root resolution now lives in @maka/storage, next to
// createConnectionStore — the two share one path authority. This file
// remains as a re-export so existing relative importers (cli.ts,
// inspect-command.ts, run-command.ts via './workspace-root.js') keep working.
export { resolveMakaWorkspaceRoot, type ResolveMakaWorkspaceRootInput } from '@maka/storage';
