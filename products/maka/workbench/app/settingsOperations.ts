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

import { cleanup, signal } from 'nsh';
import type { Host } from './host';
import { createText, errorText, message, UiError } from './text';
import type {
  AgentGlobalInstructionsUpdate,
  AgentGlobalInstructionsUpdated,
  ClientOperation,
  CredentialStatus,
  CredentialVersionBasis,
} from '../../../../packages/plugin-sdk/src/generated/runtime';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function settingsValue(reply: unknown): unknown {
  const receipt = record(reply) && record(reply.receipt) ? reply.receipt : null;
  const outcome = receipt?.kind === 'recorded' && record(receipt.outcome) ? receipt.outcome : null;
  if (outcome?.kind !== 'returned')
    throw new UiError(
      'The result is unknown. Recover the original action before making another change.',
    );
  return outcome.value;
}

export const credentialBasis = (status: CredentialStatus | null): CredentialVersionBasis | null =>
  status?.configured && status.credentialId !== null && status.revision !== null
    ? { locator: status.locator, credentialId: status.credentialId, revision: status.revision }
    : null;
export function settingsRejection(value: any): UiError {
  if (
    value?.kind === 'connection_stale' ||
    value?.kind === 'revision_conflict' ||
    value?.kind === 'superseded' ||
    value?.kind === 'credential_stale' ||
    value?.reason === 'credential_changed' ||
    value?.reason === 'connection_changed'
  )
    return new UiError('These settings changed elsewhere. Reload before saving again.');
  if (value?.kind === 'connection_exists')
    return new UiError('That connection ID is already in use. Choose another ID.');
  if (value?.kind === 'invalid_default_target')
    return new UiError('Enable the connection and model before making it the default.');
  return new UiError('The Host rejected this action ({reason}).', {
    reason: value?.reason ?? value?.kind ?? message('unknown result'),
  });
}
// One presentation owner for the existing native journal. The Client's
// atomic reservation remains the write fence across pages and processes.
export function createSettingsOperations(host: Host) {
  const busy = signal(false);
  const idle = new Set<() => void>();
  const whenIdle = () =>
    busy() ? new Promise<void>((resolve) => idle.add(resolve)) : Promise.resolve();
  const complete = () => {
    if (alive) busy.set(false);
    for (const resolve of idle) resolve();
    idle.clear();
  };
  const error = createText();
  const notice = createText();
  const pending = signal<ClientOperation[]>([]);
  const pendingKnown = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason));
  };
  const refreshPending = async () => {
    try {
      const rows = await host.pendingSettings();
      if (alive) {
        pending.set(rows);
        pendingKnown.set(true);
      }
    } catch (reason) {
      if (alive) pendingKnown.set(false);
      throw reason;
    }
  };
  function mutate(
    endpoint: 'agent',
    method: 'updateGlobalInstructions',
    input: AgentGlobalInstructionsUpdate,
  ): Promise<AgentGlobalInstructionsUpdated>;
  function mutate(
    endpoint: 'settings' | 'setup' | 'authentication' | 'management',
    method: string,
    input: unknown,
    secret?: string | null,
  ): Promise<any>;
  async function mutate(
    endpoint: 'settings' | 'setup' | 'authentication' | 'management' | 'agent',
    method: string,
    input: unknown,
    secret: string | null = null,
  ): Promise<unknown> {
    return settingsValue((await host.settingsMutation(endpoint, method, input, secret)).reply);
  }
  const run = async (operation: () => Promise<void>) => {
    if (!alive || busy() || !pendingKnown() || pending().length) return;
    busy.set(true);
    error.set('');
    notice.set('');
    try {
      await operation();
    } catch (reason) {
      report(reason);
    } finally {
      await refreshPending().catch(report);
      complete();
    }
  };
  const recover = (
    afterKnown: (original: ClientOperation, value: unknown) => void | Promise<void>,
  ) => {
    if (!alive || busy()) return;
    busy.set(true);
    error.set('');
    void (async () => {
      try {
        for (const original of await host.pendingSettings()) {
          if (!original.reference) continue;
          const value = settingsValue(await host.recoverSetting(original.id));
          if (!alive) return;
          if (original.endpoint === 'agent' && original.method === 'updateGlobalInstructions') {
            // File CAS outcomes belong to the instruction editor, which preserves
            // an unsaved draft when the original receipt reports a conflict.
            await afterKnown(original, value);
            continue;
          }
          if (
            original.endpoint === 'management' ||
            (original.endpoint === 'settings' && original.method === 'updateWorkspaceLocations')
          ) {
            if (!record(value) || value.status !== 'committed') {
              if (record(value) && value.status === 'conflict')
                throw new UiError('These settings changed elsewhere. Reload before saving again.');
              if (record(value) && typeof value.diagnostic === 'string')
                throw new Error(value.diagnostic);
              throw new UiError('The Host rejected this service change. Reload and review it.');
            }
          } else {
            const outcome = record(value) && value.kind === 'applied' ? value.result : value;
            if (
              !record(outcome) ||
              !['committed', 'saved', 'ready'].some((kind) => kind === outcome.kind)
            )
              throw settingsRejection(outcome);
          }
          await afterKnown(original, value);
        }
        if (alive) notice.set(message('Original settings action receipts checked.'));
      } catch (reason) {
        report(reason);
      } finally {
        await refreshPending().catch(report);
        complete();
      }
    })();
  };
  const abandon = (id: string) => {
    if (!alive || busy()) return;
    busy.set(true);
    error.set('');
    void (async () => {
      try {
        await host.abandonSetting(id);
      } catch (reason) {
        report(reason);
      } finally {
        await refreshPending().catch(report);
        complete();
      }
    })();
  };
  void refreshPending().catch(report);
  return {
    busy,
    whenIdle,
    error,
    notice,
    pending,
    pendingKnown,
    report,
    mutate,
    run,
    recover,
    abandon,
  };
}
export type SettingsOperations = ReturnType<typeof createSettingsOperations>;
