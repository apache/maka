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
import type {
  WebBackend,
  WebSearchEndpoint,
  WebSettings,
  WebSnapshot,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { GroupRow, InsetGroup } from '../../ui';
import { LocalizedSettingsError, settingsRpc, settingsWork } from '../../state/settings/rpc';
import { saveWebSettings, updateWebKey } from '../../state/settings/web';
import {
  confirmDeleteApiKey,
  SettingChoice,
  SettingStatus,
  SettingField,
  SettingsForm,
  SettingSwitch,
  type SettingsPageProps,
} from './SettingsForm';

export function WebSearchSettingsScreen(props: SettingsPageProps) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const basis = signal<WebSnapshot | null>(null);
  const draft = signal<WebSettings | null>(null);
  const secret = signal('');
  const urlParameters = signal('{}');
  const body = signal('{}');
  cleanup(() => secret.set(''));

  const accept = (snapshot: WebSnapshot) => {
    basis.set(snapshot);
    draft.set(snapshot.settings);
    const endpoint =
      snapshot.settings.backend?.kind === 'custom' ? snapshot.settings.backend.endpoint : null;
    urlParameters.set(JSON.stringify(endpoint?.urlParameters ?? {}, null, 2));
    body.set(JSON.stringify(endpoint?.body ?? {}, null, 2));
  };
  const reload = () =>
    void work.run(async () => accept(await rpc.query('workspaceWeb', 'snapshot', {})));
  reload();
  const settings = () => draft()!;
  const edit = (changes: Partial<WebSettings>) => draft.set({ ...settings(), ...changes });
  const backend = () => settings().backend;
  const custom = () => {
    const value = backend();
    return value?.kind === 'custom' ? value.endpoint : undefined;
  };
  const editCustom = (change: Partial<WebSearchEndpoint>) =>
    edit({ backend: { kind: 'custom', endpoint: { ...custom()!, ...change } } });
  const locations = () => [
    { id: 'query' as const, label: tr('URL query') },
    ...(custom()?.method === 'post' ? [{ id: 'body' as const, label: tr('JSON body') }] : []),
  ];
  const parameter = (field: 'query' | 'limit', label: string) => {
    const value = () => custom()![field] ?? { name: '', location: 'query' as const };
    return (
      <>
        <SettingField
          label={label}
          value={value().name}
          disabled={work.busy()}
          divider
          edit={(name) =>
            editCustom({ [field]: name || field === 'query' ? { ...value(), name } : null })
          }
        />
        <If when={field === 'query' || custom()?.limit}>
          <SettingChoice
            title={field === 'query' ? tr('Search query location') : tr('Result limit location')}
            divider
            options={locations()}
            value={value().location}
            disabled={work.busy()}
            change={(location) => editCustom({ [field]: { ...value(), location } })}
          />
        </If>
      </>
    );
  };
  const resultField = (field: keyof WebSearchEndpoint['results'], label: string) => (
    <SettingField
      label={label}
      value={custom()!.results[field] ?? ''}
      disabled={work.busy()}
      divider={field !== 'snippet'}
      edit={(value) => editCustom({ results: { ...custom()!.results, [field]: value } })}
    />
  );
  const dirty = () => {
    if (!basis()) return false;
    const previous = basis()!.settings.backend;
    return (
      JSON.stringify(settings()) !== JSON.stringify(basis()!.settings) ||
      (previous?.kind === 'custom' &&
        (urlParameters() !== JSON.stringify(previous.endpoint.urlParameters, null, 2) ||
          body() !== JSON.stringify(previous.endpoint.body, null, 2)))
    );
  };
  const save = () =>
    void work.run(async () => {
      const value = settings();
      const endpoint = custom();
      if (!endpoint) return accept(await saveWebSettings(rpc, basis()!, value));
      let urlParams: unknown;
      let jsonBody: unknown;
      try {
        urlParams = JSON.parse(urlParameters());
        jsonBody = JSON.parse(body());
      } catch (cause) {
        throw new LocalizedSettingsError('Enter a JSON object.', { cause });
      }
      if (
        !urlParams ||
        typeof urlParams !== 'object' ||
        Array.isArray(urlParams) ||
        Object.values(urlParams).some((entry) => typeof entry !== 'string') ||
        !jsonBody ||
        typeof jsonBody !== 'object' ||
        Array.isArray(jsonBody)
      ) {
        throw new LocalizedSettingsError('Enter valid JSON objects for the search parameters.');
      }
      accept(
        await saveWebSettings(rpc, basis()!, {
          ...value,
          backend: {
            kind: 'custom',
            endpoint: {
              ...endpoint,
              url: endpoint.url.trim(),
              urlParameters: urlParams as Record<string, string>,
              body: jsonBody as Record<string, unknown>,
            },
          },
        }),
      );
    });
  const credential = (action: 'saveKey' | 'deleteKey' | 'checkKey') => {
    const key = action === 'saveKey' ? secret() : undefined;
    void work.run(
      async () => {
        accept(await updateWebKey(rpc, basis()!, action, key));
        if (action !== 'checkKey') secret.set('');
      },
      action === 'saveKey' ? tr('Could not save the search API key.') : undefined,
    );
  };
  const options = (): { id: WebBackend['kind']; label: string }[] => [
    { id: 'tavily', label: 'Tavily' },
    { id: 'brave', label: 'Brave' },
    { id: 'exa', label: 'Exa' },
    { id: 'serper', label: 'Serper' },
    ...(basis()?.presets.length ? [{ id: 'custom' as const, label: tr('Custom endpoint') }] : []),
  ];
  const deleteKey = async () => {
    const current = work.fence();
    if ((await confirmDeleteApiKey()) && current() && !dirty()) credential('deleteKey');
  };
  const checkStatus = () => {
    switch (basis()?.credential.check?.outcome) {
      case 'valid':
        return { label: tr('Connected'), tone: 'success' } as const;
      case 'invalid_credentials':
        return { label: tr('Invalid API key'), tone: 'destructive' } as const;
      case 'rate_limited':
        return { label: tr('Rate limited'), tone: 'warning' } as const;
      case 'network_error':
        return { label: tr('Connection error'), tone: 'destructive' } as const;
      case 'timeout':
        return { label: tr('Connection timed out'), tone: 'warning' } as const;
    }
  };
  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Web Search')}
      work={work}
      ready={!!draft()}
      reload={reload}
      dirty={dirty()}
      save={save}
    >
      <InsetGroup>
        <SettingSwitch
          title={tr('Enable web search')}
          checked={settings().enabled}
          disabled={work.busy()}
          divider
          change={(enabled) => edit({ enabled })}
        />
        <SettingChoice
          title={tr('Search source')}
          value={settings().source}
          options={[
            { id: 'model', label: tr('Model') },
            { id: 'custom', label: tr('Search provider') },
          ]}
          disabled={work.busy()}
          divider={settings().source === 'custom'}
          change={(source) => {
            if (source === settings().source) return;
            secret.set('');
            edit({ source });
          }}
        />
        <If when={settings().source === 'custom'}>
          <SettingChoice
            title={tr('Search provider')}
            value={backend()?.kind ?? 'tavily'}
            options={options()}
            disabled={work.busy()}
            change={(kind) => {
              if (kind === 'custom') {
                const preset =
                  basis()!.presets.find((item) => item.id === backend()?.kind) ??
                  basis()!.presets[0];
                edit({ backend: { kind, endpoint: preset.endpoint } });
                urlParameters.set(JSON.stringify(preset.endpoint.urlParameters, null, 2));
                body.set(JSON.stringify(preset.endpoint.body, null, 2));
              } else edit({ backend: { kind } });
              secret.set('');
            }}
          />
        </If>
      </InsetGroup>
      <If when={settings().source === 'custom' && custom()}>
        <InsetGroup header={tr('Custom endpoint')}>
          <SettingField
            label="URL"
            value={custom()!.url}
            keyboard="url"
            edit={(url) => editCustom({ url })}
            divider
            disabled={work.busy()}
          />
          <SettingChoice
            title={tr('HTTP method')}
            divider
            value={custom()!.method}
            disabled={work.busy()}
            options={[
              { id: 'get', label: 'GET' },
              { id: 'post', label: 'POST' },
            ]}
            change={(method) => {
              const value = custom()!;
              if (method === 'post') return editCustom({ method });
              body.set('{}');
              editCustom({
                method,
                body: {},
                query: { ...value.query, location: 'query' },
                limit: value.limit ? { ...value.limit, location: 'query' } : null,
                auth:
                  value.auth?.location === 'body'
                    ? { ...value.auth, location: 'header' }
                    : value.auth,
              });
            }}
          />
          {parameter('query', tr('Search query parameter'))}
          {parameter('limit', tr('Result limit parameter (optional)'))}
          <SettingField
            label={tr('URL parameters')}
            value={urlParameters()}
            multiline
            edit={urlParameters.set}
            divider={custom()?.method === 'post'}
            disabled={work.busy()}
          />
          <If when={custom()?.method === 'post'}>
            <SettingField
              label={tr('Request body')}
              value={body()}
              multiline
              edit={body.set}
              disabled={work.busy()}
            />
          </If>
        </InsetGroup>
        <InsetGroup header={tr('Search authentication')}>
          <SettingChoice
            title={tr('Authentication location')}
            divider={!!custom()?.auth}
            value={custom()!.auth?.location ?? 'none'}
            disabled={work.busy()}
            options={[
              { id: 'none', label: tr('No authentication') },
              { id: 'header', label: tr('HTTP header') },
              ...locations(),
            ]}
            change={(location) =>
              editCustom({
                auth:
                  location === 'none'
                    ? null
                    : {
                        location,
                        name: custom()!.auth?.name ?? '',
                        prefix: custom()!.auth?.prefix ?? '',
                      },
              })
            }
          />
          <If when={custom()?.auth}>
            <SettingField
              label={tr('Authentication field name')}
              value={custom()!.auth!.name}
              edit={(name) => editCustom({ auth: { ...custom()!.auth!, name } })}
              disabled={work.busy()}
              divider
            />
            <SettingField
              label={tr('Authentication value prefix (optional)')}
              value={custom()!.auth!.prefix}
              edit={(prefix) => editCustom({ auth: { ...custom()!.auth!, prefix } })}
              disabled={work.busy()}
            />
          </If>
        </InsetGroup>
        <InsetGroup header={tr('Search result mapping')}>
          {resultField('list', tr('Results array path'))}
          {resultField('url', tr('Result URL path'))}
          {resultField('title', tr('Result title path (optional)'))}
          {resultField('snippet', tr('Result snippet path (optional)'))}
        </InsetGroup>
      </If>
      <If when={settings().source === 'custom' && custom() && !custom()?.auth}>
        <InsetGroup>
          <GroupRow
            title={tr('Test connection')}
            tone="primary"
            disabled={work.busy() || dirty()}
            trailing={
              checkStatus() ? (
                <SettingStatus label={checkStatus()!.label} tone={checkStatus()!.tone} />
              ) : undefined
            }
            onPress={() => credential('checkKey')}
          />
        </InsetGroup>
      </If>
      <If when={settings().source === 'custom' && (!custom() || custom()?.auth)}>
        <InsetGroup
          header={tr('API Key')}
          footer={
            dirty() ? tr('Save your provider settings before changing its API key.') : undefined
          }
        >
          <SettingField
            label={basis()?.credential.configured ? tr('Replace API key') : tr('API Key')}
            value={secret()}
            edit={secret.set}
            secret
            divider
            disabled={work.busy() || dirty()}
          />
          <GroupRow
            title={tr('Save API key')}
            tone="primary"
            divider={!!basis()?.credential.configured}
            disabled={work.busy() || dirty() || !secret().trim()}
            onPress={() => credential('saveKey')}
          />
          <If when={basis()?.credential.configured}>
            <GroupRow
              title={tr('Test connection')}
              trailing={
                checkStatus() ? (
                  <SettingStatus label={checkStatus()!.label} tone={checkStatus()!.tone} />
                ) : undefined
              }
              tone="primary"
              divider
              disabled={work.busy() || dirty()}
              onPress={() => credential('checkKey')}
            />
            <GroupRow
              title={tr('Delete API key')}
              tone="destructive"
              disabled={work.busy() || dirty()}
              onPress={() => void deleteKey()}
            />
          </If>
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}
