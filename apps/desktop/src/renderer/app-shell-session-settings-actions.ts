import type {
  ChatDefaultPermissionMode,
  LlmConnection,
  PermissionMode,
  SessionSummary,
  ThinkingLevel,
  UiLocale,
} from '@maka/core';
import { saveComposerDefaults } from './composer-defaults';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  confirm(input: {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

export interface AppShellSessionSettingsActions {
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setSessionModel(input: { llmConnectionSlug: string; model: string }): Promise<void>;
  setSessionThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
}

export function createAppShellSessionSettingsActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  connections: readonly LlmConnection[];
  pendingPermissionModeChangesRef: RefBox<Set<string>>;
  pendingSessionModelChangesRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionsRef: RefBox<SessionSummary[]>;
  setDefaultPermissionMode: (mode: ChatDefaultPermissionMode) => void;
  setPendingPermissionModeBySession: BooleanRecordUpdater;
  setPendingSessionModelBySession: BooleanRecordUpdater;
  setSessions: (updater: (current: SessionSummary[]) => SessionSummary[]) => void;
  toastApi: ToastApi;
}): AppShellSessionSettingsActions {
  const {
    uiLocale,
    activeIdRef,
    connections,
    pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef,
    refreshSessions,
    sessionsRef,
    setDefaultPermissionMode,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    setSessions,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionSettingsActions;

  function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
    if (!(sessionId in current)) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  }

  async function setPermissionMode(mode: PermissionMode) {
    if (mode !== 'ask' && mode !== 'bypass') return;
    const sessionId = activeIdRef.current;
    const pendingKey = sessionId ?? '__global_permission_mode__';
    if (pendingPermissionModeChangesRef.current.has(pendingKey)) return;
    if (
      mode === 'bypass' &&
      !(await toastApi.confirm({
        title: uiLocale === 'zh' ? '绕过此会话的沙箱？' : 'Bypass the sandbox for this session?',
        description:
          uiLocale === 'zh'
            ? '本地工具将可以访问工作区外文件与网络。只有在你完全信任此任务时才继续。'
            : 'Local tools will be able to access files outside the workspace and the network. Continue only if you fully trust this task.',
        confirmLabel: uiLocale === 'zh' ? '绕过沙箱' : 'Bypass sandbox',
        cancelLabel: uiLocale === 'zh' ? '保持自动' : 'Keep Auto',
        destructive: true,
      }))
    ) {
      return;
    }

    pendingPermissionModeChangesRef.current.add(pendingKey);
    if (sessionId)
      setPendingPermissionModeBySession((current) => ({
        ...current,
        [sessionId]: true,
      }));
    try {
      let nextMode = mode;
      if (sessionId) {
        const next = await window.maka.sessions.setPermissionMode(sessionId, mode);
        nextMode = next.permissionMode === 'bypass' ? 'bypass' : 'ask';
        setSessions((prev) =>
          prev.map((session) => (session.id === sessionId ? next : session)),
        );
      } else {
        const result = await window.maka.settings.update({
          chatDefaults: { permissionMode: mode },
        });
        nextMode = result.settings.chatDefaults.permissionMode;
        setDefaultPermissionMode(nextMode);
      }
      toastApi.success(
        copy.permissionSwitched(copy.permissionLabels[nextMode]),
        copy.permissionDescriptions[nextMode],
      );
      await refreshSessions();
    } catch (error) {
      toastApi.error(copy.permissionFailedTitle, localizedShellErrorMessage(error, copy.permissionFallback, uiLocale));
    } finally {
      pendingPermissionModeChangesRef.current.delete(pendingKey);
      if (sessionId) setPendingPermissionModeBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionModel(input: { llmConnectionSlug: string; model: string }) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    if (pendingSessionModelChangesRef.current.has(sessionId)) return;
    pendingSessionModelChangesRef.current.add(sessionId);
    setPendingSessionModelBySession((current) => ({
      ...current,
      [sessionId]: true,
    }));
    try {
      const next = await window.maka.sessions.setModel(sessionId, input);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      const connection = connections.find((entry) => entry.slug === next.llmConnectionSlug);
      if (activeIdRef.current === sessionId) {
        toastApi.success(copy.modelSwitchedTitle, `${connection?.name ?? next.llmConnectionSlug} · ${next.model}`);
      }
      saveComposerDefaults({ model: input });
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(copy.modelFailedTitle, localizedShellErrorMessage(error, copy.modelFallback, uiLocale));
      }
    } finally {
      pendingSessionModelChangesRef.current.delete(sessionId);
      setPendingSessionModelBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionThinkingLevel(level: ThinkingLevel | undefined) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (current && current.thinkingLevel === level) return;
    try {
      const next = await window.maka.sessions.setThinkingLevel(sessionId, level);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      if (activeIdRef.current === sessionId) {
        toastApi.success(copy.thinkingUpdatedTitle, level ? copy.thinkingLabels[level] : copy.thinkingDefault);
      }
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(copy.thinkingFailedTitle, localizedShellErrorMessage(error, copy.thinkingFallback, uiLocale));
      }
    }
  }

  return {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  };
}
