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

import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { resolveMakaClientDataRoot } from '@maka/storage/workspace-root';
import type { ProjectCatalog } from '@maka/storage/project-catalog';
import type { HostProjectMembershipGate } from './project-membership-gate.js';

export class HostPersonalAssistantWorkspace {
  constructor(
    private readonly deps: {
      stateRoot: string;
      homeDirectory?: string;
      projects: Pick<ProjectCatalog, 'register'>;
      membership: HostProjectMembershipGate;
      projectChanged(): void;
      preflightSessionCreation(): Promise<void>;
    },
  ) {}

  async allocate(): Promise<{ projectId: string }> {
    // Validate the model and Host execution policy before creating durable
    // project/filesystem state; a failed Session create must not leave a task.
    await this.deps.preflightSessionCreation();
    // The Host resolves its own home. No Client-supplied path or Project enters
    // this operation; every component under home must be a real directory.
    const home = this.deps.homeDirectory ?? homedir();
    // Follow the existing local Desktop/CLI dev profile convention. A remote
    // deployment has its own State Root; the connecting Client does not select
    // its workspace namespace. Every allocation receives a fresh task directory.
    const profileRoots = await Promise.all(
      ['Maka Dev', 'Maka Dev Worktrees'].map(async (profileName) => {
        const root = resolveMakaClientDataRoot({ profileName, homeDir: home });
        return realpath(root).catch(() => root);
      }),
    );
    const development = profileRoots.some((parent) => {
      const suffix = relative(parent, this.deps.stateRoot);
      return (
        suffix === '' ||
        (!isAbsolute(suffix) &&
          suffix !== '..' &&
          !suffix.startsWith('../') &&
          !suffix.startsWith('..\\'))
      );
    });
    let cwd = await realpath(home);
    for (const segment of [development ? 'Maka Dev' : 'Maka', 'tasks']) {
      cwd = join(cwd, segment);
      await mkdir(cwd, { recursive: true });
      const info = await lstat(cwd);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error(`Assistant workspace must be a real directory: ${cwd}`);
      if (typeof process.getuid === 'function' && info.uid !== process.getuid())
        throw Error(`Assistant workspace belongs to another user: ${cwd}`);
    }
    const root = await realpath(cwd);
    if (relative(cwd, root) !== '')
      throw Error('Assistant workspace escaped its managed directory');
    const expected = await mkdtemp(join(root, 'task-'));
    cwd = await realpath(expected);
    if (dirname(cwd) !== root || basename(cwd) !== basename(expected))
      throw Error('Assistant workspace escaped its managed directory');
    const project = await this.deps.membership.run(async () => {
      const registered = await this.deps.projects.register(cwd, { withinRoot: expected });
      if (
        registered.archivedAt !== undefined ||
        !registered.available ||
        registered.preferredPath !== cwd
      )
        throw Error(
          'Assistant project is archived, unavailable, or has moved; restore it before opening',
        );
      this.deps.projectChanged();
      return registered;
    });
    return { projectId: project.id };
  }
}
