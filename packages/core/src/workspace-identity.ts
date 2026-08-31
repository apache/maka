export const WORKSPACE_IDENTITY_PREFIX = 'workspace:v1:' as const;

export type WorkspaceIdentity = `${typeof WORKSPACE_IDENTITY_PREFIX}${string}`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isWorkspaceIdentityUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function workspaceIdentityFromUuid(value: string): WorkspaceIdentity {
  if (!isWorkspaceIdentityUuid(value)) throw new Error('Invalid Workspace identity UUID');
  return `${WORKSPACE_IDENTITY_PREFIX}${value.toLowerCase()}`;
}

export function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
  if (typeof value !== 'string' || !value.startsWith(WORKSPACE_IDENTITY_PREFIX)) return false;
  const uuid = value.slice(WORKSPACE_IDENTITY_PREFIX.length);
  return isWorkspaceIdentityUuid(uuid) && uuid === uuid.toLowerCase();
}
