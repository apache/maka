// Workspace-root resolution now lives in @maka/storage, next to
// createConnectionStore — the two share one path authority. This file
// remains as a re-export so existing relative CLI importers keep working.
export {
  deriveMakaDataRoots,
  resolveMakaClientDataRoot,
  resolveMakaDataRoots,
  resolveMakaWorkspaceRoot,
  type DeriveMakaDataRootsInput,
  type MakaDataRoots,
  type ResolveMakaClientDataRootInput,
  type ResolveMakaWorkspaceRootInput,
} from '@maka/storage';
