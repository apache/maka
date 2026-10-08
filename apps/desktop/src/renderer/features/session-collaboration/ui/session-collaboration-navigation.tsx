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

import { useEffect, useState } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { useUiLocale } from '@maka/ui';
import { Share2 } from '@maka/ui/icons';
import { desktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';
import { SessionCollaborationJoinDialog } from './session-collaboration-join-dialog.js';
import { useSessionCollaborationServices } from '../services-context.js';

/** Access records remain reachable even before a Session catalog has arrived. */
export function SessionCollaborationNavigation(props: {
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const [open, setOpen] = useState(false);
  const [hasMounts, setHasMounts] = useState(false);
  const services = useSessionCollaborationServices();
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void services.listMounts().then((mounts) => {
        if (!disposed && request === revision) setHasMounts(mounts.length > 0);
      }, () => undefined);
    };
    refresh();
    const unsubscribe = services.subscribeMountChanges(refresh);
    return () => { disposed = true; unsubscribe(); };
  }, [services]);
  return <>
    {hasMounts ? <SideNavItem label={copy.retainedTasks} icon={Share2} size="md" onClick={() => setOpen(true)} /> : null}
    {open ? <SessionCollaborationJoinDialog copy={copy}
      onClose={() => setOpen(false)} onImported={() => undefined}
      onOpenTask={(mount) => {
        if (mount.session) props.onOpenSession(desktopSessionKey({
          hostId: mount.hostId, sessionId: mount.session.id,
        }));
      }} /> : null}
  </>;
}
