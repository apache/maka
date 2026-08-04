import type {
  CreateManagedWorkspaceFromSourceInput,
  GitWorkspaceService,
  ManagedWorkspaceBaselineReceiptV1,
  ManagedWorkspaceBinding,
} from './git-workspace-service.js';

export interface ManagedBaselineReceiptAuthorityInternal {
  issue(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBaselineReceiptV1>;
  require(input: CreateManagedWorkspaceFromSourceInput): Promise<ManagedWorkspaceBaselineReceiptV1>;
  verify(receipt: ManagedWorkspaceBaselineReceiptV1): Promise<void>;
}

const receiptAuthorities = new WeakMap<
  GitWorkspaceService,
  ManagedBaselineReceiptAuthorityInternal
>();

export function registerManagedBaselineReceiptAuthorityInternal(
  service: GitWorkspaceService,
  authority: ManagedBaselineReceiptAuthorityInternal,
): void {
  if (receiptAuthorities.has(service)) {
    throw new Error('Managed baseline receipt authority is already registered');
  }
  receiptAuthorities.set(service, authority);
}

export function requireManagedBaselineReceiptAuthorityInternal(
  service: GitWorkspaceService,
): ManagedBaselineReceiptAuthorityInternal {
  const authority = receiptAuthorities.get(service);
  if (!authority) {
    throw new Error('Managed baseline receipt authority is unavailable');
  }
  return authority;
}
