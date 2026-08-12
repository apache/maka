import { stat } from 'node:fs/promises';
import { deriveTaskSubmissionReadiness, type TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import { type LlmConnection } from '@maka/core/llm-connections';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface DesktopTaskSubmissionReadinessRequest {
  connectionSlug?: string;
  model?: string;
  cwd?: string;
}

export interface DesktopTaskSubmissionReadinessDeps {
  workspaceRoot: string;
  runtimeState(): { state: 'ready' | 'starting' | 'unavailable' | 'unknown'; checkedAt: number };
  resolveModelTarget(requestedSlug: string | undefined): Promise<DesktopModelTargetResolution>;
  inspectWorkspace?(cwd: string): Promise<'ready' | 'missing' | 'unavailable' | 'unknown'>;
  now?(): number;
}

export type DesktopModelTargetResolution =
  | { kind: 'resolved'; connection: LlmConnection; hasSecret?: boolean }
  | { kind: 'missing_default' }
  | { kind: 'connection_missing'; connectionSlug: string }
  | { kind: 'unknown' };

export async function resolveStoredModelTarget(
  requestedSlug: string | undefined,
  deps: {
    getSnapshot(): Promise<{ defaultSlug: string | null; connections: LlmConnection[] }>;
    hasCredential(connection: LlmConnection): Promise<boolean>;
  },
): Promise<DesktopModelTargetResolution> {
  const catalog = await deps.getSnapshot();
  const connectionSlug = requestedSlug ?? catalog.defaultSlug ?? undefined;
  if (!connectionSlug) return { kind: 'missing_default' };
  const connection = catalog.connections.find((candidate) => candidate.slug === connectionSlug);
  if (!connection) return { kind: 'connection_missing', connectionSlug };
  const hasSecret = await deps.hasCredential(connection).catch(() => undefined);
  return { kind: 'resolved', connection, hasSecret };
}

export function createDesktopTaskSubmissionReadinessService(
  deps: DesktopTaskSubmissionReadinessDeps,
) {
  return {
    async getSnapshot(input: unknown): Promise<TaskSubmissionReadinessSnapshot> {
      const request = normalizeRequest(input);
      const checkedAt = deps.now?.() ?? Date.now();
      const modelTarget = await deps.resolveModelTarget(request.connectionSlug);
      const cwd = request.cwd ?? deps.workspaceRoot;
      const workspaceState = await (deps.inspectWorkspace ?? inspectWorkspace)(cwd);

      return deriveTaskSubmissionReadiness({
        checkedAt,
        runtime: deps.runtimeState(),
        modelTarget:
          modelTarget.kind === 'resolved'
            ? { ...modelTarget, requestedModel: request.model, checkedAt }
            : { ...modelTarget, checkedAt },
        workspace: { state: workspaceState, checkedAt },
      });
    },
  };
}

export function registerTaskSubmissionReadinessIpc(
  service: ReturnType<typeof createDesktopTaskSubmissionReadinessService>,
  target: ReconnectableReadIpcMain,
): void {
  handleReconnectableRead(target, 'taskReadiness:getSnapshot', (_event, input: unknown) =>
    service.getSnapshot(input),
  );
}

async function inspectWorkspace(
  cwd: string,
): Promise<'ready' | 'missing' | 'unavailable' | 'unknown'> {
  try {
    return (await stat(cwd)).isDirectory() ? 'ready' : 'unavailable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Missing path is repairable (pick a workspace). Access failures stay
    // unavailable; everything else is an unknown observation.
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'EACCES') return 'unavailable';
    return 'unknown';
  }
}

function normalizeRequest(input: unknown): DesktopTaskSubmissionReadinessRequest {
  if (input === undefined) return {};
  if (!isPlainObject(input)) throw new TypeError('INVALID_TASK_READINESS_REQUEST');
  const allowed = new Set(['connectionSlug', 'model', 'cwd']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError('INVALID_TASK_READINESS_REQUEST');
  }
  return {
    ...optionalNonEmptyString(input, 'connectionSlug'),
    ...optionalNonEmptyString(input, 'model'),
    ...optionalNonEmptyString(input, 'cwd'),
  };
}

function optionalNonEmptyString(
  input: Record<string, unknown>,
  key: 'connectionSlug' | 'model' | 'cwd',
): Partial<DesktopTaskSubmissionReadinessRequest> {
  const value = input[key];
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('INVALID_TASK_READINESS_REQUEST');
  }
  return { [key]: value.trim() };
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
