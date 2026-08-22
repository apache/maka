import type { UiLocale } from '@maka/core/ui-locale';
import type { ToastDiagnosticTarget } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy.js';

const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

export function showSessionWorkspaceUnavailableToast(
  toastApi: {
    error(
      title: string,
      description?: string,
      diagnosticDetails?: string,
      diagnosticTarget?: ToastDiagnosticTarget,
    ): void;
  },
  locale: UiLocale,
  diagnosticTarget?: ToastDiagnosticTarget,
): void {
  const copy = getShellCopy(locale).errors;
  toastApi.error(
    copy.workspaceUnavailableTitle,
    copy.workspaceUnavailableDescription,
    undefined,
    diagnosticTarget,
  );
}

export function isSessionWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const event = error as { code?: unknown; message?: unknown };
  return (
    event.code === SESSION_WORKSPACE_UNAVAILABLE_CODE ||
    (typeof event.message === 'string' && event.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`))
  );
}
