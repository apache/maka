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

import { host, mount, signal, View } from 'nsh';
import type { Browsing, BrowserProject, BrowserScope, BrowserSession } from '../../app/browsing';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { DAY_MS, HOUR_MS, MINUTE_MS, MONTH_MS, YEAR_MS } from '../../app/sidebarRelativeTime';
import { WorkspaceBrowser } from '../../app/WorkspaceBrowser';

const workspacePath = '/work/maka';
const project: BrowserProject = {
  reference: { id: 'project-1', revision: 'rev-1' },
  name: 'Maka',
  archived: false,
  available: true,
  path: workspacePath,
};

function makeSession(
  id: string,
  title: string,
  updatedAt: number,
  options: Partial<
    Pick<
      BrowserSession,
      'activity' | 'hasActiveChildren' | 'hasUnread' | 'parentSessionId' | 'pinned' | 'workspace'
    >
  > = {},
): BrowserSession {
  return {
    id,
    kind: 'agent',
    revision: 1,
    title,
    labels: [],
    updatedAt,
    archived: false,
    pinned: options.pinned ?? false,
    parentSessionId: options.parentSessionId ?? null,
    activity: options.activity ?? 'idle',
    hasActiveChildren: options.hasActiveChildren ?? false,
    hasUnread: options.hasUnread ?? false,
    tailMessageId: null,
    branch: null,
    permissions: { access: 'workspace_write', requestPermissions: true },
    boundaryRevision: 1,
    binding: { id: '47a24946-26e1-4451-9584-19e5120dfab8', permissionEpoch: 1 },
    dataSource: {
      stateDomain: '0'.repeat(64),
      deployment: '47a24946-26e1-4451-9584-19e5120dfab8',
      namespace: [],
    },
    workspace: options.workspace ?? { projectId: project.reference.id, path: workspacePath },
  };
}

function Fixture() {
  installWorkbenchLocaleCatalog();
  const baseNow = Date.now();
  const selected = signal<string | null>('selected-1y');
  const sessions = signal<BrowserSession[]>([
    makeSession('pinned-5m', 'Pinned caption alignment check', baseNow - 5 * MINUTE_MS, {
      pinned: true,
      workspace: { path: '/work/alpha-repo' },
    }),
    makeSession('selected-1y', 'Selected annual roadmap review', baseNow - YEAR_MS),
    makeSession('idle-now', 'Fresh quick check', baseNow - 20_000),
    makeSession(
      'idle-59m',
      'Investigate trailing timestamp alignment on narrow desktop sidebar rows',
      baseNow - 59 * MINUTE_MS,
    ),
    makeSession(
      'idle-11mo',
      'Audit eleven month relative timestamp width and truncation boundary',
      baseNow - 11 * MONTH_MS,
    ),
    makeSession('unread-2h', 'Unread release checklist review', baseNow - 2 * HOUR_MS, {
      hasUnread: true,
    }),
    makeSession('working-17d', 'Running integration suite now', baseNow - 17 * DAY_MS, {
      activity: 'working',
      hasUnread: true,
    }),
  ]);
  const bubbledChildren = signal<BrowserSession[]>([
    makeSession('bubble-4h', 'Waiting helper task', baseNow - 4 * HOUR_MS, {
      parentSessionId: 'idle-now',
      activity: 'waiting',
    }),
  ]);

  host.on('locale', (value: unknown) => {
    if (typeof value === 'string') currentLocale.set(value);
  });
  host.on('set-row-state', (value: unknown) => {
    const patch = value as {
      id: string;
      activity?: BrowserSession['activity'];
      hasUnread?: boolean;
    };
    sessions.set(
      sessions().map((session) =>
        session.id === patch.id
          ? {
              ...session,
              activity: patch.activity ?? session.activity,
              hasUnread: patch.hasUnread ?? session.hasUnread,
            }
          : session,
      ),
    );
  });

  const scope: BrowserScope = { kind: 'all' };
  const browsing: Browsing = {
    scope: () => scope,
    filter: () => 'all',
    needsYouCount: () => 0,
    sessions,
    hasMore: () => false,
    loading: () => false,
    projects: () => [project],
    error: () => '',
    projectError: () => '',
    setScope() {},
    setFilter() {},
    async refresh() {},
    async loadMore() {
      return 'complete';
    },
  };

  return (
    <View style={{ flex: 1 }}>
      <WorkspaceBrowser
        browsing={browsing}
        bubbledChildren={bubbledChildren}
        docked={() => true}
        connectionLost={() => false}
        selected={selected}
        switching={() => false}
        focusRequest={() => false}
        focusHandled={() => {}}
        attach={() => {}}
        close={() => {}}
        collapse={() => {}}
        selectSession={async (id) => {
          selected.set(id);
          return true;
        }}
        create={async () => {}}
        newConversation={() => {}}
        settings={() => {}}
        search={() => {}}
        changeSession={async () => {}}
      />
    </View>
  );
}

mount(Fixture);
