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

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useUiLocale } from '@maka/ui';
import type { SessionNavigationPorts, SessionNavigationSessionService } from '../ports.js';
import { createSessionNavigationRowActions } from './session-row-actions.js';

export function useSessionNavigationRowActions(ports: SessionNavigationPorts, service: SessionNavigationSessionService) {
  const locale = useUiLocale();
  // The ports are commands, so their identity is not information. Published on
  // commit and called through the ref, they can carry whatever the shell
  // rebuilt this render without the rail hearing about it — which is what lets
  // the row actions below be built once, per locale, instead of per render.
  //
  // This is one indirection in one place, and it replaces the alternative the
  // shell was drifting towards: hand-stabilising every function that happens to
  // be upstream of the rail, where a single ordinary `function` declaration
  // anywhere in the chain silently undoes the whole thing (#4109).
  const portsRef = useRef(ports);
  const pendingSessionRowActionsRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    portsRef.current = ports;
  });

  const commands = useMemo(
    () =>
      createSessionNavigationRowActions({
        uiLocale: locale,
        acquireAutomaticQueryBlock: (sessionIds) =>
          portsRef.current.acquireAutomaticQueryBlock(sessionIds),
        clearSessionRendererState: (sessionId) =>
          portsRef.current.clearSessionRendererState(sessionId),
        pendingSessionRowActionsRef,
        refreshSessions: () => portsRef.current.refreshSessions(),
        service,
        sessionsRef: portsRef.current.sessionsRef,
        toastApi: {
          success: (title, description) => portsRef.current.toastApi.success(title, description),
          error: (title, description, details, target) =>
            portsRef.current.toastApi.error(title, description, details, target),
          confirm: (options) => portsRef.current.toastApi.confirm(options),
        },
      }),
    [locale, service],
  );

  return commands;
}
