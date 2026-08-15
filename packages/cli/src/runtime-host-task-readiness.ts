import { stat } from 'node:fs/promises';
import {
  deriveTaskSubmissionReadiness,
  type TaskSubmissionReadinessDimension,
  type TaskSubmissionReadinessSnapshot,
} from '@maka/core/task-submission-readiness';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
import { providerAuthRequiresSecret } from '@maka/core/llm-connections';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';

export interface RuntimeHostCliTaskReadinessInput {
  readonly connection: RuntimeHostConnection;
  readonly catalog: ConnectionCatalogSnapshot;
  readonly cwd: string;
  readonly connectionSlug?: string;
  readonly model?: string;
  readonly workspaceState?: 'ready' | 'missing' | 'unavailable' | 'unknown';
}

export async function readRuntimeHostCliTaskReadiness(
  input: RuntimeHostCliTaskReadinessInput,
  now: () => number = Date.now,
): Promise<TaskSubmissionReadinessSnapshot> {
  const checkedAt = now();
  const entry = resolveCatalogEntry(input.catalog, input.connectionSlug);
  const modelTarget = entry
    ? {
        kind: 'resolved' as const,
        connection: catalogEntryAsLlmConnection(entry, input.catalog),
        hasSecret: await readHasSecret(input.connection, entry),
        requestedModel: input.model,
        checkedAt,
      }
    : input.connectionSlug
      ? { kind: 'connection_missing' as const, connectionSlug: input.connectionSlug, checkedAt }
      : { kind: 'missing_default' as const, checkedAt };

  return deriveTaskSubmissionReadiness({
    checkedAt,
    runtime: { state: 'ready', checkedAt },
    modelTarget,
    workspace: { state: input.workspaceState ?? (await inspectWorkspace(input.cwd)), checkedAt },
  });
}

export function isRuntimeHostCliTaskBlocked(snapshot: TaskSubmissionReadinessSnapshot): boolean {
  return snapshot.state === 'repair_required' || snapshot.state === 'unavailable';
}

export function formatRuntimeHostCliTaskBlockers(
  snapshot: TaskSubmissionReadinessSnapshot,
  cliCommand = 'maka',
): string {
  return snapshot.blockers
    .filter((blocker) => blocker.state !== 'unknown')
    .map((blocker) => `${blocker.blockerCode ?? blocker.id}: ${repairHint(blocker, cliCommand)}`)
    .join('\n');
}

function resolveCatalogEntry(
  catalog: ConnectionCatalogSnapshot,
  requestedSlug: string | undefined,
): ConnectionCatalogEntry | undefined {
  if (requestedSlug) {
    return catalog.connections.find((candidate) => candidate.slug === requestedSlug);
  }
  return catalog.connections.find(
    (candidate) => candidate.connectionId === catalog.defaultTarget?.connectionId,
  );
}

function catalogEntryAsLlmConnection(
  entry: ConnectionCatalogEntry,
  catalog: ConnectionCatalogSnapshot,
): LlmConnection {
  const defaultModel =
    entry.connectionId === catalog.defaultTarget?.connectionId
      ? catalog.defaultTarget.modelId
      : (entry.enabledModelIds[0] ?? '');
  return {
    slug: entry.slug,
    name: entry.name,
    providerType: entry.providerType,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    enabled: entry.enabled,
    defaultModel,
    enabledModelIds: [...entry.enabledModelIds],
    models: [...entry.models],
    ...(entry.modelSource ? { modelSource: entry.modelSource } : {}),
    ...(entry.modelsFetchedAt ? { modelsFetchedAt: entry.modelsFetchedAt } : {}),
    ...(entry.lastTest
      ? { lastTestStatus: entry.lastTest.status, lastTestAt: entry.lastTest.checkedAt }
      : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

async function readHasSecret(
  connection: RuntimeHostConnection,
  entry: ConnectionCatalogEntry,
): Promise<boolean | undefined> {
  if (!providerAuthRequiresSecret(entry.providerType)) return false;
  const authKind = PROVIDER_DEFAULTS[entry.providerType].authKind;
  const kind = authKind === 'oauth_token' ? 'oauth_token' : 'api_key';
  try {
    const result = await connection.request('credential.vault.query', {
      locator: { scope: 'connection', connectionId: entry.connectionId, kind },
    });
    return result.kind === 'status' ? result.status.configured : undefined;
  } catch {
    return undefined;
  }
}

async function inspectWorkspace(
  cwd: string,
): Promise<'ready' | 'missing' | 'unavailable' | 'unknown'> {
  try {
    return (await stat(cwd)).isDirectory() ? 'ready' : 'unavailable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'EACCES') return 'unavailable';
    return 'unknown';
  }
}

function repairHint(blocker: TaskSubmissionReadinessDimension, cliCommand: string): string {
  const target = blocker.repairTarget;
  if (!target) return 'retry the command';
  switch (target.kind) {
    case 'provider_catalog':
      return `run \`${cliCommand}\` to configure a model provider`;
    case 'connection':
      return `repair connection "${target.connectionSlug}" in \`${cliCommand}\``;
    case 'models':
      return 'choose an available connection with `--connection`';
    case 'runtime_restart':
      return 'restart Maka and retry';
    case 'workspace_picker':
      return 'choose an existing directory with `--cwd`';
    case 'system_permission':
      return `grant system permission "${target.permissionId}"`;
    case 'capability_settings':
      return `enable capability "${target.capabilityId}"`;
  }
}
