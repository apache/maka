import { stat } from 'node:fs/promises';
import type { ipcMain as electronIpcMain } from 'electron';
import {
  deriveTaskSubmissionReadiness,
  type LlmConnection,
  type TaskSubmissionReadinessSnapshot,
} from '@maka/core';

export interface DesktopTaskSubmissionReadinessRequest {
  connectionSlug?: string;
  model?: string;
  cwd?: string;
}

export interface DesktopTaskSubmissionReadinessDeps {
  workspaceRoot: string;
  runtimeState(): { state: 'ready' | 'starting' | 'unavailable' | 'unknown'; checkedAt: number };
  listConnections(): Promise<LlmConnection[]>;
  getDefaultSlug(): Promise<string | null>;
  hasCredential(connection: LlmConnection): Promise<boolean>;
  inspectWorkspace?(cwd: string): Promise<'ready' | 'unavailable' | 'unknown'>;
  now?(): number;
}

export function createDesktopTaskSubmissionReadinessService(
  deps: DesktopTaskSubmissionReadinessDeps,
) {
  return {
    async getSnapshot(input: unknown): Promise<TaskSubmissionReadinessSnapshot> {
      const request = normalizeRequest(input);
      const checkedAt = deps.now?.() ?? Date.now();
      const [connections, defaultSlug] = await Promise.all([
        deps.listConnections(),
        deps.getDefaultSlug(),
      ]);
      const connectionSlug = request.connectionSlug ?? defaultSlug ?? undefined;
      const connection = connectionSlug
        ? connections.find((candidate) => candidate.slug === connectionSlug)
        : undefined;
      const hasSecret = connection
        ? await deps.hasCredential(connection).catch(() => undefined)
        : undefined;
      const cwd = request.cwd ?? deps.workspaceRoot;
      const workspaceState = await (deps.inspectWorkspace ?? inspectWorkspace)(cwd);

      return deriveTaskSubmissionReadiness({
        checkedAt,
        runtime: deps.runtimeState(),
        modelTarget: {
          connection,
          hasSecret,
          requestedModel: request.model,
          checkedAt,
        },
        workspace: { state: workspaceState, checkedAt },
      });
    },
  };
}

export function registerTaskSubmissionReadinessIpc(
  service: ReturnType<typeof createDesktopTaskSubmissionReadinessService>,
  target: Pick<typeof electronIpcMain, 'handle'>,
): void {
  target.handle('taskReadiness:getSnapshot', (_event, input: unknown) =>
    service.getSnapshot(input),
  );
}

async function inspectWorkspace(cwd: string): Promise<'ready' | 'unavailable' | 'unknown'> {
  try {
    return (await stat(cwd)).isDirectory() ? 'ready' : 'unavailable';
  } catch (error) {
    return isConfirmedMissingWorkspace(error) ? 'unavailable' : 'unknown';
  }
}

function isConfirmedMissingWorkspace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES';
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
