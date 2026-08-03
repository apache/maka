import { ipcMain } from 'electron';
import { isBrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { BrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { BrowserWorkflowStore } from '@maka/storage';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { createBrowserWorkflowService } from './browser/browser-workflow-service.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';
import {
  desktopSessionResourceKey,
  parseDesktopSessionResourceKey,
  requireDesktopHostRef,
  type DesktopHostRef,
} from '../preload/runtime-host-identity.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
  browserWorkflowStore: BrowserWorkflowStore;
  getActiveHostRef(): DesktopHostRef | undefined;
}

export interface BrowserIpcController {
  releaseSession(sessionId: string): Promise<void>;
  retireTarget(scope: DesktopHostRef): Promise<void>;
}

const WORKFLOW_ID_MAX_LENGTH = 200;
const SENSITIVE_VALUE_MAX_LENGTH = 100_000;
const SENSITIVE_VALUE_COUNT_MAX = 500;

function requireWorkflowId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new Error('Invalid browser workflow id.');
  }
  return value;
}

function normalizeSensitiveValues(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser workflow sensitive values.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SENSITIVE_VALUE_COUNT_MAX) throw new Error('Too many browser workflow sensitive values.');
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > 100 || typeof raw !== 'string' || raw.length > SENSITIVE_VALUE_MAX_LENGTH) {
      throw new Error('Invalid browser workflow sensitive value.');
    }
    Object.defineProperty(normalized, key, { value: raw, enumerable: true, configurable: true, writable: true });
  }
  return normalized;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): BrowserIpcController {
  let shownBrowserSessionId: string | null = null;
  const browserWorkflows = createBrowserWorkflowService({
    store: deps.browserWorkflowStore,
    views: deps.mainWindowController.getBrowserViews(),
    sendToRenderer: (_channel, payload) => {
      const ref = parseDesktopSessionResourceKey(payload.sessionId);
      deps.mainWindowController.send(
        'browser:workflow-progress',
        { hostId: ref.hostId, targetEpoch: ref.targetEpoch },
        { ...payload, sessionId: ref.sessionId },
      );
    },
  });
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const requireActiveHost = (scope: unknown): DesktopHostRef => {
    const activeHost = deps.getActiveHostRef();
    if (!activeHost) throw new Error('Desktop Runtime Host identity is unavailable');
    return requireDesktopHostRef(scope, activeHost);
  };
  const requireBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const host = requireActiveHost(scope);
    return typeof target === 'string' && target.length > 0
      ? desktopSessionResourceKey({ ...host, sessionId: target })
      : undefined;
  };
  const shownBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const resourceKey = requireBrowserTarget(scope, target);
    return resourceKey === shownBrowserSessionId ? resourceKey : undefined;
  };

  ipcMain.on('browser:active-session', (_event, scope: unknown, sessionId: unknown) => {
    try {
      const nextSessionId = requireBrowserTarget(scope, sessionId) ?? null;
      const previousSessionId = shownBrowserSessionId;
      shownBrowserSessionId = nextSessionId;
      deps.mainWindowController.getBrowserViews().hideAllExcept(shownBrowserSessionId);
      revokeHiddenBrowserActions(shownBrowserSessionId);
      if (previousSessionId && previousSessionId !== nextSessionId) {
        void browserWorkflows.releaseSession(previousSessionId);
      }
    } catch {
      return;
    }
  });

  ipcMain.on('browser:setViewport', (_event, scope: unknown, input: { sessionId?: unknown; rect?: BrowserViewRect | null }) => {
    try {
      const target = shownBrowserTarget(scope, input?.sessionId);
      if (target) deps.mainWindowController.getBrowserViews().setViewport(target, input.rect ?? null);
    } catch {
      return;
    }
  });

  ipcMain.handle('browser:navigate', async (_event, scope: unknown, target: unknown, url: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) await deps.mainWindowController.getBrowserViews().getOrCreate(resourceKey).navigate(String(url ?? ''));
  });
  ipcMain.handle('browser:back', (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) deps.mainWindowController.getBrowserViews().get(resourceKey)?.goBack();
  });
  ipcMain.handle('browser:forward', (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) deps.mainWindowController.getBrowserViews().get(resourceKey)?.goForward();
  });
  ipcMain.handle('browser:reload', (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) deps.mainWindowController.getBrowserViews().get(resourceKey)?.reload();
  });
  ipcMain.handle('browser:stop', (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) deps.mainWindowController.getBrowserViews().get(resourceKey)?.stop();
  });
  ipcMain.handle('browser:get-state', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    return resourceKey ? deps.mainWindowController.getBrowserViews().get(resourceKey)?.state() ?? null : null;
  });
  ipcMain.handle('browser:prepare-view', async (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (!resourceKey) return;
    const previousSessionId = shownBrowserSessionId;
    shownBrowserSessionId = resourceKey;
    deps.mainWindowController.getBrowserViews().hideAllExcept(resourceKey);
    revokeHiddenBrowserActions(resourceKey);
    if (previousSessionId && previousSessionId !== resourceKey) {
      await browserWorkflows.releaseSession(previousSessionId);
    }
    deps.mainWindowController.getBrowserViews().getOrCreate(resourceKey);
  });
  ipcMain.handle('browser:close-page', async (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (resourceKey) {
      await browserWorkflows.releaseSession(resourceKey);
      await releaseBrowserSession(resourceKey);
    }
  });

  ipcMain.handle('browser:workflow-list', (_event, scope: unknown) => {
    requireActiveHost(scope);
    return browserWorkflows.list();
  });
  ipcMain.handle('browser:workflow-start-recording', async (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (!resourceKey || typeof target !== 'string') throw new Error('The browser session is not currently visible.');
    const handle = await browserWorkflows.startRecording(resourceKey);
    return { ...handle, sessionId: target };
  });
  ipcMain.handle('browser:workflow-stop-recording', async (_event, scope: unknown, target: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (!resourceKey) throw new Error('The browser session is not currently visible.');
    return browserWorkflows.stopRecording(resourceKey);
  });
  ipcMain.handle('browser:workflow-add-wait', async (_event, scope: unknown, target: unknown, input: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (!resourceKey) throw new Error('The browser session is not currently visible.');
    if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
    return browserWorkflows.addWaitCondition(resourceKey, input as BrowserWorkflowWaitConditionInput);
  });
  ipcMain.on('browser:workflow-release-session', (_event, scope: unknown, target: unknown) => {
    try {
      const resourceKey = requireBrowserTarget(scope, target);
      if (resourceKey) void browserWorkflows.releaseSession(resourceKey);
    } catch {
      return;
    }
  });
  ipcMain.handle('browser:workflow-save-recording', (_event, scope: unknown, draftId: unknown, name: unknown) => {
    requireActiveHost(scope);
    if (typeof draftId !== 'string' || typeof name !== 'string') throw new Error('Invalid browser workflow draft.');
    return browserWorkflows.saveRecording(draftId, name);
  });
  ipcMain.on('browser:workflow-discard-recording', (_event, scope: unknown, draftId: unknown) => {
    try {
      requireActiveHost(scope);
      if (typeof draftId === 'string') browserWorkflows.discardRecording(draftId);
    } catch {
      return;
    }
  });
  ipcMain.handle('browser:workflow-run', async (_event, scope: unknown, workflowId: unknown, target: unknown, values: unknown) => {
    const resourceKey = shownBrowserTarget(scope, target);
    if (!resourceKey) throw new Error('The browser session is not currently visible.');
    await browserWorkflows.run(requireWorkflowId(workflowId), resourceKey, normalizeSensitiveValues(values));
  });
  ipcMain.on('browser:workflow-cancel', (_event, scope: unknown, runId: unknown) => {
    try {
      requireActiveHost(scope);
      if (typeof runId === 'string') browserWorkflows.cancel(runId);
    } catch {
      return;
    }
  });
  ipcMain.handle('browser:workflow-rename', (_event, scope: unknown, workflowId: unknown, name: unknown) => {
    requireActiveHost(scope);
    if (typeof name !== 'string') throw new Error('Invalid browser workflow.');
    return browserWorkflows.rename(requireWorkflowId(workflowId), name);
  });
  ipcMain.handle('browser:workflow-delete', (_event, scope: unknown, workflowId: unknown) => {
    requireActiveHost(scope);
    return browserWorkflows.remove(requireWorkflowId(workflowId));
  });

  return {
    releaseSession: (sessionId) => browserWorkflows.releaseSession(sessionId),
    async retireTarget(scope) {
      shownBrowserSessionId = null;
      const views = deps.mainWindowController.getBrowserViews();
      views.hideAllExcept(null);
      revokeHiddenBrowserActions(null);
      const retired = views.sessionIds().filter((sessionId) => {
        const ref = parseDesktopSessionResourceKey(sessionId);
        return ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch;
      });
      await Promise.all(retired.map(async (sessionId) => {
        await browserWorkflows.releaseSession(sessionId);
        await releaseBrowserSession(sessionId);
      }));
    },
  };
}
