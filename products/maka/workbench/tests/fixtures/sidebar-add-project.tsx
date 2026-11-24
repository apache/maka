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

import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  AgentProject,
  AgentProjectLocation,
  AgentSession,
  AgentSessionFilter,
} from '../../../../../packages/plugin-sdk/src/index.js';
import type { Browsing, BrowserScope } from '../../app/browsing';
import { HostProvider, type Host } from '../../app/host';
import { applyLanguagePreference } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { ProjectRestoreDialog } from '../../app/ProjectRestoreDialog';
import { createProjectRegistrationController } from '../../app/projectRegistration';
import { WorkspaceBrowser } from '../../app/WorkspaceBrowser';
import { WorkspacePicker } from '../../app/WorkspacePicker';

const noop = () => {};
const asyncNoop = async () => {};
const empty = async () => [];
const baseName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
const reply = (value: unknown) => ({
  operationId: 'op-1',
  reply: {
    receipt: {
      kind: 'recorded',
      outcome: { kind: 'returned', result: { kind: 'success', value } },
    },
  },
});
const makeProject = (id: string, name: string, path: string, archived = false) =>
  ({
    reference: { id, revision: 'a'.repeat(64) },
    name,
    archived,
    available: true,
    path,
  }) as AgentProject;
const makeSession = (
  id: string,
  title: string,
  pinned = false,
  parentSessionId: string | null = null,
  activity: 'idle' | 'working' | 'waiting' = 'idle',
) =>
  ({
    kind: 'agent',
    id,
    title,
    pinned,
    parentSessionId,
    updatedAt: 1_700_000_000_000,
    labels: [],
    archived: false,
    hasUnread: false,
    activity,
    branch: null,
    workspace: { path: '/work/alpha', projectId: 'p-alpha' },
  }) as unknown as AgentSession;

type Overlay =
  | { kind: 'workspaces'; instance: number }
  | {
      kind: 'restore_project';
      instance: number;
      project: AgentProject;
      location: AgentProjectLocation;
    };

const LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;

function Fixture() {
  const scope = signal<BrowserScope>({ kind: 'all' });
  const filter = signal<AgentSessionFilter>('all');
  const sessions = signal<AgentSession[]>([]);
  const bubbled = signal<AgentSession[]>([]);
  const projects = signal<AgentProject[]>([]);
  const selected = signal<string | null>('s-active');
  const collapsed = signal<ReadonlySet<string>>(new Set());
  const sidebarWidth = signal(280);
  const localeIndex = signal(0);
  const overlay = signal<Overlay | null>(null);
  let [langRevision, nextOverlay] = [1, 0];
  const counts = signal({ create: 0, select: 0, close: 0, register: 0, restore: 0 });
  const bump = (key: keyof ReturnType<typeof counts>) =>
    counts.set({ ...counts(), [key]: counts()[key] + 1 });
  let serverProjects: AgentProject[] = [makeProject('p-legacy', 'Legacy', '/work/legacy', true)];

  const browsing: Browsing = {
    scope,
    filter,
    sessions,
    projects,
    needsYouCount: () => 0,
    hasMore: () => false,
    loading: () => false,
    error: () => '',
    projectError: () => '',
    setScope: (next) => scope.set(next),
    setFilter: (next) => filter.set(next),
    loadMore: async () => 'complete',
    refresh: async () => projects.set(serverProjects.map((p) => ({ ...p }))),
  };

  const host = {
    localFolderPicker: false,
    refresh: asyncNoop,
    pendingSettings: empty,
    pendingControls: empty,
    query: async (ep: string, m: string, input: any) => {
      const path = String(input.path ?? '');
      if (ep === 'agent' && m === 'directories') {
        if (input.kind === 'roots')
          return { kind: 'roots', roots: [{ name: 'work', path: '/work' }] };
        const children =
          path === '/work'
            ? ['alpha', 'legacy'].map((name) => ({ name, path: `/work/${name}` }))
            : [];
        return {
          kind: 'children',
          directory: { name: baseName(path), path },
          children,
          after: null,
        };
      }
      if (ep === 'agent' && m === 'projects') {
        const project = serverProjects.find((p) => p.path === path) ?? null;
        return { kind: 'directory', location: { path, name: baseName(path), project } };
      }
      throw new Error(`Unexpected query ${ep}.${m}`);
    },
    control: async (_method: string, input: any) => {
      if (input.kind === 'register') {
        bump('register');
        const created = makeProject('p-alpha', baseName(String(input.path)), input.path);
        serverProjects = [...serverProjects.filter((p) => p.reference.id !== 'p-alpha'), created];
        return reply({ kind: 'committed', project: created });
      }
      bump('restore');
      const target = serverProjects.find((p) => p.reference.id === input.project.id);
      if (!target) return reply({ kind: 'unavailable' });
      const restored = {
        ...target,
        archived: false,
        reference: { id: target.reference.id, revision: 'b'.repeat(64) },
      };
      serverProjects = serverProjects.map((p) =>
        p.reference.id === restored.reference.id ? restored : p,
      );
      return reply({ kind: 'committed', project: restored });
    },
  } as unknown as Host;

  const expandProject = (id: string) => {
    const next = new Set(collapsed());
    if (next.delete(`project:${id}`)) collapsed.set(next);
  };
  const registration = createProjectRegistrationController({
    host,
    useNativeFolderPicker: () => false,
    alive: () => true,
    refresh: () => browsing.refresh(),
    expandProject,
    openPicker: () => overlay.set({ kind: 'workspaces', instance: ++nextOverlay }),
    openRestore: ({ project, location }) =>
      overlay.set({ kind: 'restore_project', instance: ++nextOverlay, project, location }),
    notifyError: noop,
  });
  const closeOverlay = (instance: number) =>
    overlay()?.instance === instance ? (overlay.set(null), true) : false;
  const seedSessions = () => {
    sessions.set([
      makeSession('s-pin', 'Pinned task', true),
      makeSession('s-alpha-1', 'Fix parser'),
    ]);
    bubbled.set([
      makeSession('s-pin-child', 'Pin sub', false, 's-pin', 'waiting'),
      makeSession('s-alpha-child', 'Sub', false, 's-alpha-1', 'waiting'),
    ]);
  };
  const cycleLocale = () => {
    const next = (localeIndex() + 1) % LOCALES.length;
    localeIndex.set(next);
    applyLanguagePreference(LOCALES[next]!, ++langRevision);
  };

  return (
    <HostProvider value={host}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ width: sidebarWidth(), height: '100%' }}>
          <WorkspaceBrowser
            browsing={browsing}
            docked={() => true}
            connectionLost={() => false}
            selected={selected}
            switching={() => false}
            focusRequest={() => false}
            focusHandled={noop}
            attach={noop}
            close={() => bump('close')}
            collapse={noop}
            selectSession={async (id) => (bump('select'), selected.set(id), true)}
            create={async () => bump('create')}
            newConversation={noop}
            addProject={registration.addProject}
            addingProject={registration.adding}
            settings={noop}
            search={noop}
            changeSession={asyncNoop}
            collapsedGroups={collapsed}
            bubbledChildren={bubbled}
          />
        </View>
        <View style={{ flex: 1, padding: 12, gap: 8 }}>
          <Text>
            {`selected:${selected()} creates:${counts().create} selects:${counts().select} closes:${counts().close} registers:${counts().register} restores:${counts().restore} width:${sidebarWidth()}`}
          </Text>
          <Button
            accessibilityLabel="Narrow sidebar"
            onPress={() => sidebarWidth.set(sidebarWidth() === 280 ? 192 : 280)}
          >
            <Text>Toggle width</Text>
          </Button>
          <Button accessibilityLabel="Seed sessions" onPress={seedSessions}>
            <Text>Seed sessions</Text>
          </Button>
          <Button accessibilityLabel="Cycle locale" onPress={cycleLocale}>
            <Text>{`locale:${LOCALES[localeIndex()]}`}</Text>
          </Button>
        </View>
        <Each of={overlay() ? [overlay()!] : []} key={(item: Overlay) => item.instance}>
          {(item) => {
            const current = item();
            return current.kind === 'restore_project' ? (
              <ProjectRestoreDialog
                project={current.project}
                location={current.location}
                close={() => closeOverlay(current.instance)}
                restored={async (p) => (await browsing.refresh(), expandProject(p.reference.id))}
              />
            ) : (
              <WorkspacePicker
                purpose="project"
                instance={current.instance}
                current={() => overlay()?.instance === current.instance}
                close={closeOverlay}
                changed={() => void browsing.refresh()}
                create={(ws) =>
                  ws.kind === 'directory' ? void registration.registerPath(ws.path) : undefined
                }
              />
            );
          }}
        </Each>
      </View>
    </HostProvider>
  );
}

installWorkbenchLocaleCatalog();
mount(Fixture);
