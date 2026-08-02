import { isDeepResearchSession, type SessionHeader } from '@maka/core/session';

export function runtimeHostSessionUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels'>,
): string | undefined {
  if (header.collaborationMode === 'plan') {
    return 'Plan sessions are not yet supported by Runtime Host.';
  }
  if (isDeepResearchSession(header.labels)) {
    return 'Deep Research sessions are not yet supported by Runtime Host.';
  }
  return undefined;
}
