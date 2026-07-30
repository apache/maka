import { ipcMain } from 'electron';
import type {
  AgentGraphClientChangedEvent,
  AgentGraphClientSnapshotOptions,
  AgentGraphCoordinator,
} from '@maka/runtime';

export interface AgentGraphIpcDeps {
  coordinator: AgentGraphCoordinator;
  sendToRenderer(channel: string, ...args: unknown[]): void;
}

/**
 * Read/control adapter for the Desktop graph client.
 *
 * The renderer receives bounded read models and invalidation hints only. It
 * never receives stores, RuntimeEvent payloads, or reconciliation authority.
 */
export function registerAgentGraphIpc(deps: AgentGraphIpcDeps): void {
  ipcMain.handle(
    'graphs:getSnapshot',
    (_event, rootSessionId: unknown, options?: unknown) =>
      deps.coordinator.getSnapshot(
        requireIdentity(rootSessionId, 'root Session id'),
        normalizeSnapshotOptions(options),
      ),
  );
  ipcMain.handle(
    'graphs:inspectOperator',
    (_event, rootSessionId: unknown, operatorId: unknown) =>
      deps.coordinator.inspectOperator(
        requireIdentity(rootSessionId, 'root Session id'),
        requireIdentity(operatorId, 'operator id'),
      ),
  );
  ipcMain.handle('graphs:stop', (_event, rootSessionId: unknown) =>
    deps.coordinator.stop(requireIdentity(rootSessionId, 'root Session id')),
  );
  deps.coordinator.subscribeAll((event: AgentGraphClientChangedEvent) => {
    deps.sendToRenderer('graphs:changed', event);
  });
}

function normalizeSnapshotOptions(value: unknown): AgentGraphClientSnapshotOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'terminalCursor')) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  if (record.terminalCursor === undefined) return {};
  return {
    terminalCursor: requireIdentity(record.terminalCursor, 'terminal cursor', 2_048),
  };
}

function requireIdentity(value: unknown, name: string, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Invalid agent graph ${name}`);
  }
  return value;
}
