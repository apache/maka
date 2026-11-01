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

import { cleanup, host as events, signal, mount, type JSX } from 'nsh';
import type { UiContext, UiHost } from '../../../../../packages/plugin-sdk/src/workbench';
import type { SettingsPageInput } from '../../../../../packages/plugin-sdk/src/workbench-views';
import { ModelSettings } from '../../../workbench/app/ModelSettings';
import { ConnectionSettings } from '../../../workbench/app/ConnectionSettings';
import { createModelSettings } from '../../../workbench/app/settings';
import { createSettingsOperations } from '../../../workbench/app/settingsOperations';
import { HostProvider, type Host } from '../../../workbench/app/host';
import { currentLocale, tr } from '../../../workbench/app/locale';

// The provider boundary is controlled by the test; every displayed control is production UI.
function Preview() {
  currentLocale.set('en');
  const provider = {
    entryId: 'maka.codex',
    name: 'chatgpt',
    packageId: 'maka.codex',
    scope: 'profile',
  };
  const definition = {
    identity: provider,
    descriptor: {
      label: 'ChatGPT Subscription',
      anonymous: false,
      customEndpoint: false,
      discovery: true,
      configurationDefaults: { baseUrl: 'https://chatgpt.com/backend-api/codex' },
      authentication: [{ id: 'device', interactive: true, label: 'Sign in with ChatGPT' }],
    },
  };
  let revision = 1;
  let catalogRevision = 1;
  let configured = false;
  let name = 'ChatGPT Subscription';
  let enabled = true;
  let modelIds: string[] = [];
  let overrides: Record<string, unknown> = {};
  let overlay: unknown = null;
  let defaultTarget: { connectionId: string; modelId: string } | null = null;
  let finishLogin: ((value: string) => void) | null = null;
  let signIns = 0;
  let discoveries = 0;
  const report = () =>
    void events.call('fixture.outcome', {
      configured,
      revision,
      signIns,
      discoveries,
      modelIds,
      overrides,
      defaultTarget,
    });
  cleanup(
    events.on<{ result: string }>('fixture.finishLogin', ({ result }) => finishLogin?.(result)),
  );
  const basis = () => ({ connectionId: 'connection', revision });
  const detail = () => ({
    kind: 'ready',
    name,
    enabled,
    target: {
      ...basis(),
      slug: 'chatgpt',
      provider,
      configuration: definition.descriptor.configurationDefaults,
    },
    editing: { enabledModelIds: modelIds, modelOverrides: overrides, requestBodyOverlay: overlay },
  });
  const receipt = (value: unknown) => ({
    reply: {
      receipt: {
        kind: 'recorded',
        outcome: { kind: 'returned', value },
        cleanup: { kind: 'confirmed' },
      },
    },
  });
  const api = {
    pendingSettings: async () => [],
    async query(_endpoint: string, method: string, input: any) {
      if (method === 'connections')
        return {
          kind: 'page',
          revision: catalogRevision,
          next: null,
          defaultTarget,
          connections: [
            {
              basis: basis(),
              name,
              slug: 'chatgpt',
              provider,
              enabled,
              enabledModelCount: modelIds.length,
              editable: true,
            },
          ],
        };
      if (method === 'providers')
        return {
          providers: [{ identity: provider, label: definition.descriptor.label }],
          next: null,
        };
      if (method === 'provider') return definition;
      if (method === 'connection')
        return input.revision === revision ? detail() : { kind: 'stale', actual: basis() };
      if (method === 'credentialStatus')
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'connection', kind: 'provider' },
            configured,
            credentialId: configured ? 'fixture-credential' : null,
            revision: configured ? 1 : null,
            updatedAt: null,
          },
        };
      if (method === 'resolveModel')
        return {
          kind: 'ready',
          defaults: {
            label: 'GPT-4.1',
            contextWindow: 128000,
            inputLimit: 128000,
            maxOutputTokens: 16384,
            compactionThreshold: null,
            thinkingLevels: ['off', 'medium', 'high'],
            defaultThinkingLevel: 'medium',
            codeMode: true,
            applyPatch: true,
            catalogMatched: input.modelId === 'gpt-4.1' || !!input.overrides?.catalogModel,
          },
          choice: {
            selection: { ...basis(), modelId: input.modelId },
            thinkingLevels: ['off', 'medium', 'high'],
            defaultThinkingLevel: 'medium',
            limits: { contextWindow: 128000, maxOutputTokens: 16384 },
          },
        };
      if (method === 'catalogModels')
        return {
          models: [{ reference: { provider: 'openai', modelId: 'gpt-4.1' }, label: 'GPT-4.1' }],
          after: null,
        };
      throw new Error(`Unexpected fixture query ${method}`);
    },
    async beginSetting(_endpoint: string, method: string, input: any) {
      if (method !== 'loginCredential' || input.expected.revision !== revision)
        throw new Error('Sign-in reused a stale connection');
      signIns++;
      report();
      let progress = true;
      const completion = new Promise<string>((resolve) => {
        finishLogin = resolve;
      });
      return {
        cancel() {
          finishLogin?.('cancelled');
        },
        async next() {
          if (progress) {
            progress = false;
            return {
              kind: 'progress',
              value: { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' },
            };
          }
          const result = await completion;
          finishLogin = null;
          if (result === 'saved') {
            configured = true;
            revision++;
            catalogRevision++;
          }
          report();
          const value =
            result === 'saved'
              ? {
                  kind: 'saved',
                  connection: {
                    connectionId: 'connection',
                    slug: 'chatgpt',
                    provider: {
                      packageId: 'maka.codex',
                      entryId: 'maka.codex',
                      scope: 'profile',
                      name: 'chatgpt',
                    },
                  },
                }
              : { kind: 'failed', reason: result, message: '' };
          return { kind: 'final', ...receipt(value), cleanupError: null };
        },
      };
    },
    async settingsMutation(_endpoint: string, method: string, input: any) {
      if (method === 'discoverModels') {
        if (input.revision !== revision) throw new Error('Discovery reused a stale connection');
        discoveries++;
        if (discoveries === 1) {
          report();
          return receipt({ kind: 'failed' });
        }
        modelIds = ['gpt-4.1', 'gpt-4.1-mini'];
        revision++;
        catalogRevision++;
        report();
        return receipt({ kind: 'ready', connection: basis() });
      }
      if (method === 'setDefault') {
        if (input.expectedCatalogRevision !== catalogRevision)
          throw new Error('Default selection reused a stale catalog');
        defaultTarget = input.target;
        catalogRevision++;
        report();
        return receipt({ kind: 'committed' });
      }
      if (method === 'update') {
        if (input.expected.revision !== revision)
          throw new Error('Editing reused a stale connection');
        name = input.changes.name ?? name;
        enabled = input.changes.enabled ?? enabled;
        modelIds = input.changes.enabledModelIds ?? modelIds;
        overrides = input.changes.modelOverrides ?? overrides;
        if ('requestBodyOverlay' in input.changes) overlay = input.changes.requestBodyOverlay;
        revision++;
        catalogRevision++;
        report();
        return receipt({ kind: 'committed', connection: basis() });
      }
      throw new Error(`Unexpected fixture mutation ${method}`);
    },
  } as unknown as Host;
  const operations = createSettingsOperations(api);
  const owner = createModelSettings(
    api,
    () => {},
    operations,
    () => true,
  );
  const instance = ['settings'];
  const contribution = {
    key: 'connections',
    id: 'connections',
    instance: { instance, path: instance },
    declaration: {
      kind: 'settings',
      title: { fallback: 'Connections & models', translations: {} },
    },
  };
  function Page(props: { input: SettingsPageInput }) {
    cleanup(
      props.input.settings!.attach({
        title: () =>
          owner.page() === 'connection'
            ? tr('Connection settings')
            : owner.page() === 'model'
              ? tr('Model settings')
              : tr('Connections & models'),
        nested: () => owner.page() !== 'connections',
        navigation: owner.navigation,
        back: owner.back,
        busy: owner.busy,
      }),
    );
    return <ConnectionSettings owner={owner} />;
  }
  const context = {
    runtime: {
      ready: () => true,
      settings: () => [contribution],
      render: (_: unknown, props: { input: SettingsPageInput }) => <Page input={props.input} />,
    },
  } as unknown as UiContext<UiHost, JSX.Element>;
  return (
    <HostProvider value={api}>
      <ModelSettings
        context={context}
        input={{ opened: () => true, close() {}, changed() {} }}
        defaultRoute={{ instance, id: 'connections' }}
        route={signal({ instance, id: 'connections' })}
        operations={operations}
        recover={() => {}}
      />
    </HostProvider>
  );
}

mount(Preview);
