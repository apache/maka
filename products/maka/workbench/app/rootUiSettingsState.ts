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

import { cleanup, computed, signal } from 'nsh';
import type {
  ClientOperation,
  DeploymentDocument,
  DeploymentRef,
  ManagementResultForDeploymentRef,
  OperationReply,
} from '../../../../packages/plugin-sdk/src/index.js';
import type {
  UiContext,
  UiContributionRef,
  UiRuntime,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import { sameValue } from '../../../../plugins/shared/value';
import { createTransientText, createText, errorText, message, UiError } from './text';

type RootUiAction = { source: DeploymentRef; key: string };
export const rootUiTitle = (choice: UiContributionRef) =>
  `${choice.instance.path.join(' / ')} · ${choice.id}`;

export function createRootUiSettings(
  runtime: UiRuntime,
  context: UiContext,
  active: () => boolean,
) {
  const query = signal('');
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
  const notice = createTransientText();
  const pending = signal<ClientOperation[]>([]);
  const pendingKnown = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason));
  };
  const management = context.services.management[0];
  const refreshPending = async () => {
    try {
      const originals = await context.operations.pending();
      if (!alive) return;
      pending.set(
        originals.filter((original) => {
          const correlation = original.correlation as { import: string };
          return original.method === 'replaceSource' && correlation.import === 'management';
        }),
      );
      pendingKnown.set(true);
    } catch (reason) {
      if (alive) pendingKnown.set(false);
      throw reason;
    }
  };
  const run = async (operation: () => Promise<void>) => {
    if (!alive || !active() || busy()) return;
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
  const choices = computed(() =>
    runtime.contributions().filter((item) => item.declaration.kind === 'root'),
  );
  const selected = (choice: UiContributionRef) => {
    const root = runtime.root();
    return (
      root !== null && root.id === choice.id && sameValue(root.instance, choice.instance.instance)
    );
  };
  const disabled = () =>
    !active() || runtime.source() === null || busy() || !pendingKnown() || pending().length > 0;
  const readDocument = async (source: DeploymentRef): Promise<DeploymentDocument> => {
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = (await management.query('readDocument', { source, offset })) as {
        text: string;
        next?: number | null;
      };
      chunks.push(chunk.text);
      offset = chunk.next ?? null;
    }
    return JSON.parse(chunks.join('')) as DeploymentDocument;
  };
  const settled = (reply: OperationReply) => {
    const receipt = reply.receipt;
    if (receipt.kind !== 'recorded' || receipt.outcome.kind !== 'returned')
      throw new UiError(
        'The result is unknown. Recover the original action before making another change.',
      );
    const result = receipt.outcome.value as ManagementResultForDeploymentRef;
    if (result.status === 'conflict')
      throw new UiError('These settings changed elsewhere. Reload before saving again.');
    if (result.status === 'rejected')
      throw new UiError('Plugin change rejected: {reason}', {
        reason: result.diagnostic ?? result.reason,
      });
    if (alive) notice.set(message('Interface selected.'));
  };
  return {
    query,
    busy,
    whenIdle,
    error,
    notice,
    pending,
    pendingKnown,
    choices,
    selected,
    current: () => choices().find(selected) ?? null,
    disabled,
    activate: () => void refreshPending().catch(report),
    recover: () =>
      run(async () => {
        await refreshPending();
        for (const original of pending()) {
          if (original.reference) settled(await context.operations.recover(original.id));
        }
      }),
    abandon: (id: string) =>
      run(async () => {
        const original = pending().find((item) => item.id === id);
        if (original && !original.reference) await context.operations.abandon(id);
      }),
    filtered: computed(() => {
      const needle = query().trim().toLowerCase();
      return choices().filter((choice) =>
        `${rootUiTitle(choice)} ${choice.instance.package.id}`.toLowerCase().includes(needle),
      );
    }),
    action(choice: UiContributionRef): RootUiAction | null {
      const source = runtime.source();
      return source === null ? null : { source, key: choice.key };
    },
    choose(request: RootUiAction | null) {
      if (request === null || disabled() || !sameValue(request.source, runtime.source())) return;
      const choice = choices().find((item) => item.key === request.key);
      if (!choice || selected(choice)) return;
      return run(async () => {
        const document = await readDocument(request.source);
        if (!active()) return;
        document.input.ui = { path: choice.instance.path, id: choice.id };
        const operation = await management.mutation('replaceSource', {
          expectedRevision: request.source.revision,
          document,
        });
        settled(operation.reply);
      });
    },
  };
}
export type RootUiSettingsOwner = ReturnType<typeof createRootUiSettings>;
