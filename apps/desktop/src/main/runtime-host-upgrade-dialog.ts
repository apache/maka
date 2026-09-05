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
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type {
  RuntimeHostRestartDecision,
  RuntimeHostUpgradePrompts,
  RuntimeHostNonRestartableDecision,
} from './runtime-host-desktop-manager.js';
import { buildRuntimeHostUpgradeDialog } from './runtime-host-upgrade-copy.js';

export function createRuntimeHostUpgradePrompts(
  resolveLocale: () => Promise<UiLocale>,
  showDialog: (
    options: MessageBoxOptions,
    locale: UiLocale,
  ) => Promise<MessageBoxReturnValue>,
): RuntimeHostUpgradePrompts {
  return {
    restartable: async (conflict): Promise<RuntimeHostRestartDecision> => {
      const locale = await resolveLocale();
      const dialog = buildRuntimeHostUpgradeDialog(conflict, 'restart', locale);
      const { response } = await showDialog(
        dialog.options,
        locale,
      );
      const decision = dialog.decisions[response] ?? 'cancel';
      return decision === 'restart' || decision === 'wait' ? decision : 'cancel';
    },
    nonRestartable: async (
      conflict,
      action,
    ): Promise<RuntimeHostNonRestartableDecision> => {
      const locale = await resolveLocale();
      const dialog = buildRuntimeHostUpgradeDialog(conflict, action, locale);
      const { response } = await showDialog(
        dialog.options,
        locale,
      );
      const decision = dialog.decisions[response] ?? 'cancel';
      return decision === 'replace' || decision === 'wait' ? decision : 'cancel';
    },
  };
}
