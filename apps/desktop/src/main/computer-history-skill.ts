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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type SkillClient = Pick<DesktopRuntimeHostClient, 'loadSkillCatalog' | 'mutateSkillCatalog'>;

const SKILL_ID = 'computer-history';
const SKILL_REF = `workspace:legacy:${SKILL_ID}`;
const MAX_REVISION_ATTEMPTS = 3;

/** Keeps this Desktop's bundled Skill current without owning content edits or preferences. */
export class ComputerHistorySkillInstaller {
  #client?: SkillClient;
  #pending?: { client: SkillClient | undefined; promise: Promise<void>; again: boolean };

  constructor(private readonly input: {
    workspaceRoot: string;
    isNeeded: () => Promise<boolean>;
    onError: (error: unknown) => void;
  }) {}

  hostChanged(profileId: string, client?: SkillClient): void {
    if (profileId !== 'local') return;
    this.#client = client;
    if (client) void this.refresh();
  }

  /** Installation is not authorization: honor the current full-ref opt-out on every model read. */
  async isEnabled(client: SkillClient): Promise<boolean> {
    if (client !== this.#client) return false;
    const catalog = await client.loadSkillCatalog(
      { workspace: { kind: 'host_path', path: this.input.workspaceRoot } },
      'governance',
    );
    return client === this.#client && catalog.items.some((item) =>
      item.kind === 'skill' && item.id === SKILL_ID && item.ref === SKILL_REF &&
      item.scope === 'workspace' && item.source === 'legacy' && item.sourceType === 'bundled' &&
      item.enabled && item.runtimeStatus === 'enabled' && !item.shadowedBy &&
      (item.validationStatus === 'ok' || item.validationStatus === 'modified'),
    );
  }

  /** Settings and Host-ready callbacks share a flight; a new connection retries independently. */
  refresh(): Promise<void> {
    const client = this.#client;
    if (this.#pending && this.#pending.client === client) {
      this.#pending.again = true;
      return this.#pending.promise;
    }
    const pending = { client, again: false, promise: Promise.resolve() };
    const promise = (async () => {
      // Drain settings/ready signals that arrived during a read. Catalog work
      // never schedules refresh itself; revision retries are bounded below.
      do {
        pending.again = false;
        try {
          await this.#installIfNeeded(client);
        } catch (error: unknown) {
          this.input.onError(error);
        }
      } while (pending.again && client === this.#client);
    })()
      .finally(() => {
        if (this.#pending?.promise === promise) this.#pending = undefined;
      });
    pending.promise = promise;
    this.#pending = pending;
    return promise;
  }

  async #installIfNeeded(client: SkillClient | undefined): Promise<void> {
    if (!(await this.input.isNeeded())) return;
    if (!client) throw new Error('Local Host is unavailable for Computer History Skill installation');
    // The publication and preferences belong to this Host's default State Root,
    // independent of the selected project, default remote Host, or conversation.
    const context = { workspace: { kind: 'host_path' as const, path: this.input.workspaceRoot } };
    for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
      if (client !== this.#client) return;
      const governance = await client.loadSkillCatalog(context, 'governance');
      if (client !== this.#client) return;
      const installed = governance.items.find((item) =>
        item.kind === 'skill' && item.ref === SKILL_REF && item.id === SKILL_ID,
      );
      if (!installed && governance.items.some((item) => item.id === SKILL_ID)) return;
      if (installed && (
        installed.kind !== 'skill' || installed.ref !== SKILL_REF ||
        installed.scope !== 'workspace' || installed.source !== 'legacy' ||
        installed.sourceType !== 'bundled' || installed.validationStatus !== 'ok' ||
        installed.userModified || installed.shadowedBy
      )) return;
      const bundled = await client.loadSkillCatalog(context, 'bundled');
      if (client !== this.#client) return;
      if (bundled.revision !== governance.revision) continue;
      const skill = bundled.items.find((item) => item.kind === 'bundled' && item.id === SKILL_ID);
      if (!skill || skill.kind !== 'bundled') throw new Error('Bundled Computer History Skill is unavailable');
      if (installed && !skill.installed) continue;
      if (!installed && skill.installed) return;
      const result = await client.mutateSkillCatalog({
        context,
        expectedRevision: bundled.revision,
        mutation: installed
          ? { kind: 'update_bundled', ref: SKILL_REF }
          : { kind: 'install', sourceType: 'bundled', sourceId: SKILL_ID },
      });
      if (result.kind === 'revision_conflict') continue;
      // An edit made after the catalog read takes ownership away from automatic updates.
      if (installed && result.kind === 'rejected' && result.reason === 'local_modified') return;
      if (result.kind === 'rejected' && result.reason !== 'already_exists') {
        throw new Error(`Computer History Skill ${installed ? 'update' : 'installation'} rejected: ${result.reason}`);
      }
      // Installation supplies the runtime default. Never set_enabled: an existing
      // full-ref opt-out survives even deletion and later reinstallation.
      return;
    }
    throw new Error('Skill catalog kept changing while installing the Computer History Skill');
  }
}
