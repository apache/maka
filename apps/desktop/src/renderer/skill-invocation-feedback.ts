/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { UiLocale } from '@maka/core/ui-locale';
import type { SkillInvocationResult } from '@maka/runtime/skill-invocation';
import { getShellCopy } from './locales/shell-copy.js';

type SkillInvocationToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
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
  sessionId: string,
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
      undefined,
      { sessionId },
    );
    return;
  }
  toastApi.info(copy.skillInvocationFailedTitle, copy.skillInvocationFailedDescription(items));
}
