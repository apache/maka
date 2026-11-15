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

import { inputAction, type JSX } from 'nsh';
import type {
  WebAuthLocation,
  WebBackend,
  WebParameter,
  WebParameterLocation,
  WebSearchEndpoint,
  WebSearchMethod,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsDiscard,
  SettingsInput,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';
import type { WebSearchSettingsOwner } from './webSearchSettingsState';

const backendChoices = [
  { value: 'tavily', title: 'Tavily' },
  { value: 'brave', title: 'Brave Search' },
  { value: 'exa', title: 'Exa' },
  { value: 'serper', title: 'Serper' },
] as const;

export function WebSearchSettings({ owner }: { owner: WebSearchSettingsOwner }) {
  return (
    <If
      when={!owner.discarding.asking()}
      else={<SettingsDiscard onDiscard={owner.discarding.discard} onKeep={owner.discarding.keep} />}
    >
      <If
        when={owner.draft() && owner.snapshot()}
        else={
          <SettingsBody>
            <If
              when={owner.loading()}
              else={
                <SettingsProblem
                  message={
                    owner.supported() ? undefined : tr('Web search is unavailable on this Host.')
                  }
                  retry={owner.supported() ? inputAction(owner.load, undefined) : undefined}
                />
              }
            >
              <LoadingIndicator label={tr('Loading web search settings…')} />
            </If>
          </SettingsBody>
        }
      >
        <WebSearchForm owner={owner} />
      </If>
    </If>
  );
}

function WebSearchForm({ owner }: { owner: WebSearchSettingsOwner }) {
  const value = () => owner.draft()!;
  const saved = () => owner.snapshot()!;
  const backend = () => value().backend;
  const endpoint = () => {
    const selected = backend();
    return selected.kind === 'custom'
      ? selected.endpoint
      : saved().presets.find((preset) => preset.id === selected.kind)!.endpoint;
  };
  const editEndpoint = <K extends keyof WebSearchEndpoint>(
    field: K,
    result: WebSearchEndpoint[K],
  ) => {
    const current = backend();
    if (current.kind === 'custom')
      owner.edit('backend', { kind: 'custom', endpoint: { ...current.endpoint, [field]: result } });
  };
  const keyDisabled = () => owner.disabled() || owner.dirty();
  const checks = () => {
    switch (saved().credential.check?.outcome) {
      case 'valid':
        return tr('Search connection verified.');
      case 'invalid_credentials':
        return tr('The search provider rejected the API key.');
      case 'rate_limited':
        return tr('The search provider rate limited the request.');
      case 'network_error':
      case 'timeout':
        return tr('The search connection test failed.');
      default:
        return undefined;
    }
  };
  const disabled = () => owner.disabled();
  return (
    <SettingsBody
      footerShown={owner.dirty()}
      footer={
        <SettingsButton
          label={tr('Save')}
          tone="primary"
          accessibilityLabel={tr('Save web search settings')}
          disabled={disabled()}
          onPress={inputAction(owner.save, undefined)}
        />
      }
    >
      <SettingsSection>
        <SettingsSwitch
          label={tr('Web tools')}
          checked={value().enabled}
          disabled={disabled()}
          onPress={() => owner.edit('enabled', !value().enabled)}
        />
        <SettingsSelect
          label={tr('Preferred search source')}
          value={value().source}
          disabled={disabled()}
          description={tr('Maka uses the other source when the preferred one is unavailable.')}
          choices={[
            { value: 'model', title: tr('Model provider first') },
            { value: 'custom', title: tr('Custom search first') },
          ]}
          change={(source) => owner.edit('source', source as WebSettingsSource)}
        />
        <SettingsSelect
          label={tr('Custom search provider')}
          value={backend().kind}
          disabled={disabled()}
          choices={[...backendChoices, { value: 'custom', title: tr('Custom endpoint') }]}
          change={(kind) => owner.selectBackend(kind as WebBackend['kind'])}
        />
        <If when={backend().kind !== 'custom'}>
          <SettingsRow label={tr('Search endpoint')} description={endpoint().url} />
        </If>
      </SettingsSection>
      <If when={backend().kind === 'custom'}>
        <EndpointForm endpoint={endpoint} edit={editEndpoint} owner={owner} />
      </If>
      <SettingsSection
        title={tr('Search connection')}
        note={checks()}
        noteWarns={saved().credential.check?.outcome !== 'valid'}
      >
        <If when={endpoint().auth}>
          <SettingsInput
            label={tr('API key')}
            value={owner.secret()}
            masked
            disabled={keyDisabled()}
            placeholder={saved().credential.configured ? tr('Stored API key') : undefined}
            change={(secret) => {
              if (!keyDisabled()) owner.secret.set(secret);
            }}
          />
          <SettingsRow
            label={tr('Save key')}
            disabled={keyDisabled() || !owner.secret().trim()}
            onPress={inputAction(owner.credential, 'saveKey')}
          />
          <If when={saved().credential.configured}>
            <SettingsRow
              label={tr('Remove API key')}
              tone="danger"
              disabled={keyDisabled()}
              onPress={inputAction(owner.credential, 'deleteKey')}
            />
          </If>
        </If>
        <SettingsRow
          label={tr('Test search connection')}
          disabled={keyDisabled() || (!!endpoint().auth && !saved().credential.configured)}
          onPress={inputAction(owner.credential, 'checkKey')}
        />
      </SettingsSection>
    </SettingsBody>
  );
}

type WebSettingsSource = NonNullable<ReturnType<WebSearchSettingsOwner['draft']>>['source'];

function EndpointForm(props: {
  endpoint(): WebSearchEndpoint;
  edit<K extends keyof WebSearchEndpoint>(field: K, value: WebSearchEndpoint[K]): void;
  owner: WebSearchSettingsOwner;
}) {
  const endpoint = props.endpoint;
  const disabled = () => props.owner.disabled();
  const locations = () => [
    { value: 'query', title: tr('URL query') },
    ...(endpoint().method === 'post' ? [{ value: 'body', title: tr('JSON body') }] : []),
  ];
  const parameter = (field: 'query' | 'limit', label: string): JSX.Element => {
    const value = () => endpoint()[field] ?? { name: '', location: 'query' as const };
    const edit = (parameter: WebParameter) =>
      props.edit(field, field === 'limit' && !parameter.name ? null : parameter);
    return (
      <>
        <SettingsInput
          label={label}
          value={value().name}
          disabled={disabled()}
          change={(name) => edit({ ...value(), name })}
        />
        <If when={field === 'query' || endpoint().limit}>
          <SettingsSelect
            label={field === 'query' ? tr('Search query location') : tr('Result limit location')}
            value={value().location}
            disabled={disabled()}
            choices={locations()}
            change={(location) => edit({ ...value(), location: location as WebParameterLocation })}
          />
        </If>
      </>
    );
  };
  const editMethod = (method: WebSearchMethod) => {
    const current = endpoint();
    if (method === 'get') {
      const query = { ...current.query, location: 'query' as const };
      const limit = current.limit ? { ...current.limit, location: 'query' as const } : null;
      const auth =
        current.auth?.location === 'body'
          ? { ...current.auth, location: 'header' as const }
          : current.auth;
      props.owner.edit('backend', {
        kind: 'custom',
        endpoint: { ...current, method, query, limit, auth, body: {} },
      });
      props.owner.parameters.set({ ...props.owner.parameters(), body: '{}' });
    } else {
      props.edit('method', method);
    }
  };
  const resultField = (field: keyof WebSearchEndpoint['results'], label: string) => (
    <SettingsInput
      label={label}
      value={endpoint().results[field] ?? ''}
      disabled={disabled()}
      change={(path) =>
        props.edit('results', {
          ...endpoint().results,
          [field]: field === 'title' || field === 'snippet' ? path || null : path,
        })
      }
    />
  );
  return (
    <>
      <SettingsSection title={tr('Search request')}>
        <SettingsInput
          label={tr('Search endpoint')}
          value={endpoint().url}
          disabled={disabled()}
          change={(url) => props.edit('url', url)}
        />
        <SettingsSelect
          label={tr('HTTP method')}
          value={endpoint().method}
          disabled={disabled()}
          choices={[
            { value: 'get', title: 'GET' },
            { value: 'post', title: 'POST' },
          ]}
          change={(method) => editMethod(method as WebSearchMethod)}
        />
        {parameter('query', tr('Search query parameter'))}
        {parameter('limit', tr('Result limit parameter (optional)'))}
        <SettingsTextArea
          label={tr('Extra URL parameters (JSON)')}
          value={props.owner.parameters().url}
          change={(url) => props.owner.parameters.set({ ...props.owner.parameters(), url })}
          disabled={disabled()}
          lines={3}
          monospace
        />
        <If when={endpoint().method === 'post'}>
          <SettingsTextArea
            label={tr('Extra JSON body fields')}
            value={props.owner.parameters().body}
            change={(body) => props.owner.parameters.set({ ...props.owner.parameters(), body })}
            disabled={disabled()}
            lines={3}
            monospace
          />
        </If>
      </SettingsSection>
      <SettingsSection title={tr('Search authentication')}>
        <SettingsSelect
          label={tr('Authentication location')}
          value={endpoint().auth?.location ?? 'none'}
          disabled={disabled()}
          choices={[
            { value: 'none', title: tr('No authentication') },
            { value: 'header', title: tr('HTTP header') },
            ...locations(),
          ]}
          change={(location) =>
            props.edit(
              'auth',
              location === 'none'
                ? null
                : {
                    name: endpoint().auth?.name ?? '',
                    prefix: endpoint().auth?.prefix ?? '',
                    location: location as WebAuthLocation,
                  },
            )
          }
        />
        <If when={endpoint().auth}>
          <SettingsInput
            label={tr('Authentication field name')}
            value={endpoint().auth?.name ?? ''}
            disabled={disabled()}
            change={(name) => props.edit('auth', { ...endpoint().auth!, name })}
          />
          <SettingsInput
            label={tr('Authentication value prefix (optional)')}
            value={endpoint().auth?.prefix ?? ''}
            disabled={disabled()}
            placeholder="Bearer "
            change={(prefix) => props.edit('auth', { ...endpoint().auth!, prefix })}
          />
        </If>
      </SettingsSection>
      <SettingsSection
        title={tr('Search result mapping')}
        note={tr(
          'Use JSON pointers such as /results and /url. Leave the list path blank for a top-level array.',
        )}
      >
        {resultField('list', tr('Results array path'))}
        {resultField('url', tr('Result URL path'))}
        {resultField('title', tr('Result title path (optional)'))}
        {resultField('snippet', tr('Result snippet path (optional)'))}
      </SettingsSection>
    </>
  );
}
