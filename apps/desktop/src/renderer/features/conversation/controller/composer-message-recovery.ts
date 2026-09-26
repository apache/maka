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

import type { QuoteRef } from '@maka/core/events';
import type { ComposerHandle } from '@maka/ui';
import type { DesktopLocalMessageDraft } from '../../../../shared/session-local-contract.js';

/** Composer-owned recovery stays in the conversation feature, not the shell. */
export function composerMessageRecovery(deps: {
  sessionId: string | undefined;
  directoryHostId: string | undefined;
  composerRef: { readonly current: Pick<ComposerHandle, 'getText' | 'setText'> | null };
  enabled: boolean;
  hasPendingContext(): boolean;
  pendingQuotes: readonly QuoteRef[];
  restoreMessageContext(sessionId: string, hostId: string | undefined, draft: DesktopLocalMessageDraft): void;
  restoreQuotes(sessionId: string, quotes: readonly QuoteRef[]): void;
}) {
  return {
    canRestoreDraft(): boolean {
      // Text, staged context, and quotes can change while the failed draft is read.
      // Read them at invocation time, including the second pre-restore check.
      const composer = deps.composerRef.current;
      return Boolean(deps.sessionId && deps.enabled && composer && !composer.getText() &&
        !deps.hasPendingContext() && deps.pendingQuotes.length === 0);
    },
    restoreDraft(draft: DesktopLocalMessageDraft): void {
      const composer = deps.composerRef.current;
      if (!deps.sessionId || !composer) return;
      deps.restoreMessageContext(deps.sessionId, deps.directoryHostId, draft);
      deps.restoreQuotes(deps.sessionId, draft.quotes);
      composer.setText(draft.text, draft.inlineReferences);
    },
  };
}
