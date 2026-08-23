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
import { openSkillFailureCopy } from './app-shell-copy';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string, diagnosticTarget?: { profileId: string }): void;
};

export function createOpenSkillAction(deps: {
  uiLocale: UiLocale;
  isSkillsSurfaceActive: () => boolean;
  toastApi: ToastApi;
}): (skillId: string) => Promise<void> {
  const { uiLocale, isSkillsSurfaceActive, toastApi } = deps;
  const copy = getShellCopy(uiLocale).skillActions;

  async function openSkill(skillId: string) {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.skills.open(skillId, 'file', host),
      );
      if (!result.ok) {
        if (isSkillsSurfaceActive())
          toastApi.error(
            copy.openFailedTitle,
            openSkillFailureCopy(result.reason, uiLocale),
            diagnosticTarget,
          );
      }
    } catch (error) {
      if (isSkillsSurfaceActive()) {
        toastApi.error(
          copy.openFailedTitle,
          localizedShellErrorMessage(error, copy.openFallback, uiLocale),
          defaultRuntimeHostDiagnosticTarget(error),
        );
      }
    }
  }

  return openSkill;
}
