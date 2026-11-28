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

import { host as shell, platform, signal } from 'nsh';
import type {
  AgentDirectory,
  AgentDirectoryPage,
  AgentProject,
  AgentProjectChange,
  AgentProjectLocation,
  AgentProjectResult,
  DirectoryRootSpec,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { tr } from './locale';
import { settingsValue } from './settingsOperations';
import { errorText, message as uiMessage, renderText, UiError } from './text';

export type WorkspaceAdmissionHost = Pick<
  Host,
  'refresh' | 'query' | 'pendingSettings' | 'settingsMutation'
>;
export type ProjectControlHost = Pick<
  Host,
  'control' | 'pendingControls' | 'recoverControl' | 'dismissControl' | 'abandonControl'
>;
export type ProjectRegistrationHost = WorkspaceAdmissionHost & ProjectControlHost;

export type WorkspaceAdmissionOptions = {
  pause?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  os?: string;
};

export type ProjectRegistrationOutcome =
  | { kind: 'registered'; project: AgentProject }
  | { kind: 'already_active'; project: AgentProject }
  | { kind: 'archived'; location: AgentProjectLocation; project: AgentProject };

const defaultPause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function pathNames(path: string, os: string = platform.os): string[] {
  return path.split(os === 'windows' ? /[\\/]/ : /\//).filter(Boolean);
}

/** The names from `root` down to `path`, or null when `path` is not in it. */
export function below(root: string, path: string, os: string = platform.os): string[] | null {
  const [base, names] = [pathNames(root, os), pathNames(path, os)];
  return base.length <= names.length && base.every((name, i) => name === names[i])
    ? names.slice(base.length)
    : null;
}

/** The innermost Host location containing a path, and the names below it. */
export function locateWorkspaceDirectory(
  rows: readonly AgentDirectory[],
  path: string,
  os: string = platform.os,
): { root: AgentDirectory; names: string[] } | null {
  return (
    rows
      .map((root) => ({ root, names: root.path ? below(root.path, path, os) : null }))
      .filter((found): found is { root: AgentDirectory; names: string[] } => found.names !== null)
      .sort((a, b) => a.names.length - b.names.length)[0] ?? null
  );
}

/** Ensures `path` is covered by an admitted Host workspace location, adding and polling if needed. */
export async function admitWorkspaceLocation(
  host: WorkspaceAdmissionHost,
  path: string,
  options?: WorkspaceAdmissionOptions,
): Promise<string> {
  const wait = options?.pause ?? defaultPause;
  const maxAttempts = options?.maxAttempts ?? 20;
  const os = options?.os ?? platform.os;

  const readRoots = async (): Promise<AgentDirectory[]> => {
    await host.refresh();
    const page: AgentDirectoryPage = await host.query('agent', 'directories', { kind: 'roots' });
    if (page.kind !== 'roots')
      throw new UiError('The Host returned a different directory view. Reopen the folder.');
    return page.roots;
  };

  if (locateWorkspaceDirectory(await readRoots(), path, os)) return path;

  const current = await host.query('settings', 'workspaceLocations', {});
  if (!current) throw new UiError('This Host does not manage workspace locations.');
  if (!current.roots.some((root: DirectoryRootSpec) => root.path === path)) {
    if ((await host.pendingSettings()).length)
      throw new UiError('Recover the unfinished settings action in Manage locations first.');
    const name =
      (pathNames(path, os).at(-1) ?? path).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() ||
      tr('Workspace');
    const labels = new Set(current.roots.map((root: DirectoryRootSpec) => root.label));
    let label = name;
    for (let suffix = 2; labels.has(label); suffix++) label = `${name} (${suffix})`;
    const value: any = settingsValue(
      (
        await host.settingsMutation('settings', 'updateWorkspaceLocations', {
          source: current.source,
          roots: [...current.roots, { label, path }],
        })
      ).reply,
    );
    if (value?.status === 'conflict')
      throw new UiError('Workspace locations changed elsewhere. Reload before saving again.');
    if (value?.status !== 'committed')
      throw new UiError('The Host rejected these workspace locations.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (locateWorkspaceDirectory(await readRoots(), path, os)) return path;
    if (attempt + 1 < maxAttempts) await wait(500);
  }
  throw new UiError('Locations saved. Waiting for the Host to apply them…');
}

const UNCONFIRMED = 'The original result is unconfirmed. Check its receipt.' as const;
const PROJECT_ERRORS = {
  changed: 'Projects changed. Refresh and review before trying again.',
  busy: 'Projects are busy. Try again in a moment.',
  invalid: 'This folder cannot be added as a project.',
  unavailable: 'This folder is unavailable or cannot be opened. Choose another location or retry.',
} as const;

function projectReplyValue(reply: unknown): AgentProjectResult {
  const receipt = record(reply) && record(reply.receipt) ? reply.receipt : null;
  if (receipt?.kind === 'unavailable' && typeof receipt.diagnostic === 'string')
    throw new Error(receipt.diagnostic);
  const outcome = receipt?.kind === 'recorded' && record(receipt.outcome) ? receipt.outcome : null;
  if (outcome?.kind === 'not_executed')
    throw new UiError('{action} did not run. Try again.', { action: uiMessage('Update project') });
  if (outcome?.kind !== 'returned' || !record(outcome.result)) throw new UiError(UNCONFIRMED);
  const { result } = outcome;
  if (result.kind === 'failure' && typeof result.diagnostic === 'string')
    throw new Error(result.diagnostic);
  if (result.kind !== 'success' || !record(result.value)) throw new UiError(UNCONFIRMED);
  return result.value as AgentProjectResult;
}

/** Reconciles unsettled `'project'` controls before dispatching a new project mutation. */
export async function reconcilePendingProjectControls(host: ProjectControlHost): Promise<void> {
  const originals = (await host.pendingControls()).filter((op) => op.method === 'project');
  for (const original of originals) {
    if (!original.reference) {
      await host.abandonControl(original.id);
      continue;
    }
    const reply = await host.recoverControl(original.id);
    const outcome = reply?.receipt?.kind === 'recorded' ? reply.receipt.outcome : null;
    if (outcome?.kind === 'unresolved') throw new UiError(UNCONFIRMED);
    if (outcome?.kind === 'unknown') await host.dismissControl(original.id);
  }
}

async function mutateProject(
  host: ProjectControlHost,
  change: AgentProjectChange,
): Promise<AgentProjectResult> {
  await reconcilePendingProjectControls(host);
  return projectReplyValue((await host.control('project', change)).reply);
}

const projectMutationError = (result: Exclude<AgentProjectResult, { kind: 'committed' }>) =>
  new UiError(PROJECT_ERRORS[result.kind]);

/** Admits `path` if needed, inspects its project identity, and registers active/new directories. */
export async function registerProjectDirectory(
  host: ProjectRegistrationHost,
  path: string,
  options?: WorkspaceAdmissionOptions,
): Promise<ProjectRegistrationOutcome> {
  const admitted = await admitWorkspaceLocation(host, path, options);
  await reconcilePendingProjectControls(host);

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await host.query('agent', 'projects', { kind: 'directory', path: admitted });
    if (page.kind === 'unavailable') throw new UiError(PROJECT_ERRORS.unavailable);
    if (page.kind === 'changed') {
      if (attempt === 0) continue;
      throw new UiError(PROJECT_ERRORS.changed);
    }
    if (page.kind !== 'directory') throw new UiError('Projects are unavailable.');

    const { location } = page;
    const existing = location.project;
    if (existing?.archived) return { kind: 'archived', location, project: existing };
    if (existing && existing.available && existing.path === location.path)
      return { kind: 'already_active', project: existing };

    const result = await mutateProject(host, {
      kind: 'register',
      path: location.path,
      expected: existing ? existing.reference : null,
    });
    if (result.kind === 'committed')
      return { kind: existing ? 'already_active' : 'registered', project: result.project };
    if (result.kind === 'changed' && attempt === 0) continue;
    throw projectMutationError(result);
  }
  throw new UiError(PROJECT_ERRORS.changed);
}

/** Restores an archived project and binds `path` if the restored project points elsewhere. */
export async function restoreArchivedProject(
  host: Pick<Host, 'query'> & ProjectControlHost,
  project: AgentProject,
  path: string,
): Promise<AgentProject> {
  const restored = await retryProjectStep(
    host,
    project,
    path,
    (target) => ({ kind: 'restore', project: target.reference }),
    (current) => !current.archived,
  );
  if (restored.available && restored.path === path) return restored;
  return retryProjectStep(
    host,
    restored,
    path,
    (target) => ({ kind: 'register', path, expected: target.reference }),
    (current) => current.available && current.path === path,
  );
}

async function retryProjectStep(
  host: Pick<Host, 'query'> & ProjectControlHost,
  initial: AgentProject,
  path: string,
  buildChange: (target: AgentProject) => AgentProjectChange,
  satisfied: (current: AgentProject) => boolean,
): Promise<AgentProject> {
  let target = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await mutateProject(host, buildChange(target));
    if (result.kind === 'committed') return result.project;
    if (result.kind === 'changed' && attempt === 0) {
      const refreshed = await host.query('agent', 'projects', { kind: 'directory', path });
      if (refreshed.kind === 'directory' && refreshed.location.project) {
        if (satisfied(refreshed.location.project)) return refreshed.location.project;
        target = refreshed.location.project;
        continue;
      }
    }
    throw projectMutationError(result);
  }
  throw new UiError(PROJECT_ERRORS.changed);
}

/** Owner-scoped sidebar project registration controller; avoids stacked dialogs across resizes. */
export function createProjectRegistrationController(input: {
  host: ProjectRegistrationHost & { readonly localFolderPicker?: boolean };
  useNativeFolderPicker(): boolean;
  alive(): boolean;
  blocked?(): boolean;
  refresh(): Promise<void>;
  expandProject(projectId: string): void;
  openPicker(): void;
  openRestore(target: { project: AgentProject; location: AgentProjectLocation }): void;
  notifyError(message: string): void;
}) {
  const adding = signal(false);

  const run = async (pickPath: () => Promise<string | null>) => {
    if (!input.alive() || adding() || input.blocked?.()) return;
    adding.set(true);
    try {
      const path = await pickPath();
      if (!path || !input.alive()) return;
      const outcome = await registerProjectDirectory(input.host, path);
      if (!input.alive()) return;
      if (outcome.kind === 'archived') {
        input.openRestore({ project: outcome.project, location: outcome.location });
        return;
      }
      await input.refresh();
      if (input.alive()) input.expandProject(outcome.project.reference.id);
    } catch (reason) {
      if (input.alive())
        input.notifyError(renderText(errorText(reason, 'Could not add the project.')));
    } finally {
      if (input.alive()) adding.set(false);
    }
  };

  const addProject = () => {
    if (!input.alive() || adding() || input.blocked?.()) return;
    if (input.useNativeFolderPicker() && input.host.localFolderPicker !== false) {
      void run(
        () => shell.call('workspace.chooseFolder', {}, { timeout: 0 }) as Promise<string | null>,
      );
      return;
    }
    input.openPicker();
  };

  return { adding, addProject, registerPath: (path: string) => run(async () => path) };
}
