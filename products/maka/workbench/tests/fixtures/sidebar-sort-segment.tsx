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

import { mount, View } from 'nsh';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { HostProvider, type Host } from '../../app/host';
import { WorkspaceBrowser } from '../../app/WorkspaceBrowser';
import type { Browsing, BrowserProject, BrowserSession } from '../../app/browsing';

installWorkbenchLocaleCatalog();

const now = Date.now();
const earlier = now - 5 * 24 * 60 * 60 * 1000;

const projects: BrowserProject[] = [
  {
    reference: { id: 'proj-alpha', revision: '1' },
    name: 'Alpha',
    archived: false,
    available: true,
    path: '/work/alpha',
  },
  {
    reference: { id: 'proj-beta', revision: '1' },
    name: 'Beta',
    archived: false,
    available: true,
    path: '/work/beta',
  },
];

const sessions: BrowserSession[] = [
  {
    id: 'session-1',
    title: 'Fix sidebar sort',
    updatedAt: now,
    pinned: false,
    archived: false,
    activity: 'idle',
    hasUnread: false,
    parentSessionId: null,
    workspace: { projectId: 'proj-alpha', path: '/work/alpha' },
  } as unknown as BrowserSession,
  {
    id: 'session-2',
    title: 'Draft release notes',
    updatedAt: earlier,
    pinned: false,
    archived: false,
    activity: 'idle',
    hasUnread: false,
    parentSessionId: null,
    workspace: { projectId: 'proj-beta', path: '/work/beta' },
  } as unknown as BrowserSession,
];

const browsing: Browsing = {
  scope: () => ({ kind: 'all' }),
  filter: () => 'all',
  sessions: () => sessions,
  needsYouCount: () => 0,
  projects: () => projects,
  hasMore: () => false,
  loading: () => false,
  error: () => '',
  projectError: () => '',
  setScope: () => {},
  setFilter: () => {},
  loadMore: async () => 'complete',
  refresh: async () => {},
};

const stubHost = {
  query: async () => ({}),
  subscribe: async () => ({ next: async () => null, close: async () => {} }),
} as unknown as Host;

mount(() => (
  <HostProvider value={stubHost}>
    <View style={{ width: 256, height: 640 }}>
      <WorkspaceBrowser
        docked={() => true}
        connectionLost={() => false}
        browsing={browsing}
        selected={() => 'session-1'}
        switching={() => false}
        focusRequest={() => false}
        focusHandled={() => {}}
        attach={() => {}}
        close={() => {}}
        collapse={() => {}}
        selectSession={async () => true}
        create={async () => {}}
        newConversation={() => {}}
        settings={() => {}}
        search={() => {}}
        changeSession={async () => {}}
      />
    </View>
  </HostProvider>
));
