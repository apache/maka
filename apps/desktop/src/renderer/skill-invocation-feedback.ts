import type { UiLocale } from '@maka/core/ui-locale';
import type { SkillInvocationResult } from '@maka/runtime/skill-invocation';
import { getShellCopy } from './locales/shell-copy.js';

type SkillInvocationToastApi = {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
};

/** Match main-process persistence for a chip-only optimistic user message. */
export function skillInvocationDisplayText(
  text: string,
  skillInvocation: SkillInvocationResult,
): string {
  if (text.trim().length > 0) return text;
  return skillInvocation.loaded.map((skill) => `/skill:${skill.id}`).join(' ');
}

/** The Composer is the only Desktop surface that invokes Skills (#1433). */
export function showSkillInvocationFeedback(
  uiLocale: UiLocale,
  toastApi: SkillInvocationToastApi,
  skillInvocation: SkillInvocationResult,
): void {
  const failures = skillInvocation.failed;
  if (failures.length === 0) return;
  const copy = getShellCopy(uiLocale).chatActions;
  const items = failures.map((failure) =>
    failure.reason === 'too_many_requests'
      ? copy.skillInvocationFailureReason[failure.reason]
      : `/skill:${failure.request} (${copy.skillInvocationFailureReason[failure.reason]})`,
  );
  if (skillInvocation.loaded.length === 0) {
    toastApi.error(
      copy.skillInvocationBlockedTitle,
      copy.skillInvocationBlockedDescription(items),
    );
    return;
  }
  toastApi.info(copy.skillInvocationFailedTitle, copy.skillInvocationFailedDescription(items));
}
