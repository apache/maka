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

import type { ProjectCatalog } from '@maka/storage';
import type { WorkspaceTarget } from '@maka/runtime-host/protocol';

export interface DesktopSessionWorkspaceInput {
  readonly cwd?: string;
  readonly projectId?: string | null;
}

interface DesktopSessionWorkspaceSelection {
  current(): Promise<{ projectId: string | null | undefined; path: string }>;
  select(projectId: unknown): Promise<{ project: { id: string } | null; path: string }>;
  defaultProjectId?(): Promise<string | undefined>;
}

export async function resolveDesktopSessionWorkspace(
  input: DesktopSessionWorkspaceInput,
  selection: DesktopSessionWorkspaceSelection,
  catalog: Pick<ProjectCatalog, 'register'>,
  options: { readonly allowHostPath?: boolean } = {},
): Promise<WorkspaceTarget> {
  if (input.cwd) {
    if (input.projectId === null) {
      if (options.allowHostPath === false) throw remoteProjectRequired();
      return { kind: 'host_path', path: input.cwd };
    }
    if (typeof input.projectId === 'string') {
      return { kind: 'project', projectId: input.projectId };
    }
    if (options.allowHostPath === false) throw remoteProjectRequired();
    return { kind: 'project', projectId: (await catalog.register(input.cwd)).id };
  }

  if (input.projectId !== undefined) {
    if (input.projectId === null) {
      if (options.allowHostPath === false) throw remoteProjectRequired();
      return { kind: 'host_path', path: (await selection.current()).path };
    }
    // Session creation names a Project; it must not also mutate the Host's
    // persisted current-Project preference. The Runtime Host validates the
    // identity at the workspace authority boundary.
    return { kind: 'project', projectId: input.projectId };
  }

  const configuredDefault = await selection.defaultProjectId?.();
  if (configuredDefault !== undefined) {
    const selected = await selection.select(configuredDefault);
    if (selected.project) return { kind: 'project', projectId: selected.project.id };
  }

  const current = await selection.current();
  if (typeof current.projectId === 'string') {
    return { kind: 'project', projectId: current.projectId };
  }
  if (options.allowHostPath === false) throw remoteProjectRequired();
  return { kind: 'host_path', path: current.path };
}

function remoteProjectRequired(): Error {
  return new Error('Select a project from the remote Runtime Host first');
}
