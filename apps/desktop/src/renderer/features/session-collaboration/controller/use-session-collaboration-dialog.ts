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

import { useCallback, useMemo, useState } from 'react';
import { useUiLocale } from '@maka/ui';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';

import type {
  SessionCollaborationDialogProjection,
  SessionCollaborationDialogTarget,
} from '../model/dialog-projection.js';

export function useSessionCollaborationDialog() {
  const [target, setTarget] = useState<SessionCollaborationDialogTarget>();
  const shareActionLabel = getSessionCollaborationCopy(useUiLocale()).shareAction;
  const openSession = useCallback<SessionCollaborationDialogProjection['openSession']>(
    (session) => {
      setTarget({
        sessionId: session.id,
        sessionName: session.name,
        requiresRemoteAccess: session.profileKind === 'local',
      });
    },
    [],
  );
  const close = useCallback(() => setTarget(undefined), []);
  const isOpen = target !== undefined;
  const shell = useMemo<SessionCollaborationDialogProjection>(
    () => ({ isOpen, shareActionLabel, openSession }),
    [isOpen, shareActionLabel, openSession],
  );
  return { target, close, shell };
}
