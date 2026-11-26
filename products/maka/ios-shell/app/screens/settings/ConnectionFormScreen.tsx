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

import { cleanup, effect, Clipboard, openUrl, signal, Text, View, token, untracked } from 'nsh';
import { AlertDialog } from 'nsh/base';
import type {
  CredentialStatus,
  Identity,
  SettingsLoginPrompt,
  SettingsProvider,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { GroupRow, InsetGroup } from '../../ui';
import {
  connectionBasis,
  deleteCredential,
  readConnection,
  readCredential,
  saveCredential,
} from '../../state/settings/models';
import { credentialBasis, settingsRpc, settingsWork } from '../../state/settings/rpc';
import { type } from '../../theme/tokens';
import {
  confirmDeleteApiKey,
  SettingField,
  SettingsForm,
  SettingSwitch,
  type SettingsPageProps,
} from './SettingsForm';

export type ConnectionTarget =
  | { connectionId: string }
  | { provider: Identity; catalogRevision: number };

export function ConnectionFormScreen(
  props: SettingsPageProps & {
    target: ConnectionTarget;
    version: number;
    openModel: (connectionId: string, connectionName: string, modelId: string) => void;
    onChanged: () => void;
  },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const detail = signal<Awaited<ReturnType<typeof readConnection>> | null>(null);
  const provider = signal<SettingsProvider | null>(null);
  const credential = signal<CredentialStatus | null>(null);
  const usage = signal<CredentialStatus | null>(null);
  const name = signal('');
  const slug = signal('');
  const baseUrl = signal('');
  const enabled = signal(true);
  const compaction = signal(false);
  const overlay = signal('');
  const advanced = signal(false);
  const key = signal('');
  const usageId = signal('');
  const usageSecret = signal('');
  const team = signal('');
  const progress = signal('');
  const login = signal<SettingsLoginPrompt | null>(null);
  const target = props.target;
  let connectionId = 'connectionId' in target ? target.connectionId : undefined;

  cleanup(() => {
    key.set('');
    usageId.set('');
    usageSecret.set('');
    team.set('');
    login.set(null);
  });
  const configuration = () =>
    detail()?.target.configuration ??
    (provider()?.descriptor.configurationDefaults as Record<string, unknown> | undefined) ??
    {};
  const supportsCompaction = () =>
    'serverSideCompaction' in configuration() ||
    !!(provider()?.descriptor.configurationSchema as { properties?: Record<string, unknown> })
      ?.properties?.serverSideCompaction;
  const initialOverlay = () =>
    detail()?.editing.requestBodyOverlay
      ? JSON.stringify(detail()!.editing.requestBodyOverlay, null, 2)
      : '';
  const load = async () => {
    const facts = connectionId ? await readConnection(rpc, connectionId) : null;
    const identity = facts?.target.provider ?? ('provider' in target ? target.provider : undefined);
    if (!identity) throw new Error(tr('Connection is unavailable'));
    const descriptor = await rpc.query('settingsAuthentication', 'provider', identity);
    const stored = facts ? await readCredential(rpc, facts.target.connectionId, 'provider') : null;
    const usageKind = descriptor.descriptor.usageAuthentication;
    const storedUsage =
      facts && (usageKind === 'access_key' || usageKind === 'team_access_key')
        ? await readCredential(rpc, facts.target.connectionId, 'usage')
        : null;
    detail.set(facts);
    credential.set(stored);
    usage.set(storedUsage);
    name.set(facts?.name ?? descriptor.descriptor.label);
    slug.set(facts?.target.slug ?? identity.name);
    baseUrl.set(String(configuration().baseUrl ?? ''));
    enabled.set(facts?.enabled ?? true);
    compaction.set(configuration().serverSideCompaction === true);
    overlay.set(initialOverlay());
    provider.set(descriptor);
    if (!facts) baseUrl.set(String(configuration().baseUrl ?? ''));
  };
  const reload = () => void work.run(load);
  const dirtyDetails = () =>
    !!provider() &&
    (!detail() ||
      name() !== detail()!.name ||
      baseUrl() !== String(configuration().baseUrl ?? '') ||
      enabled() !== detail()!.enabled ||
      compaction() !== (configuration().serverSideCompaction === true) ||
      overlay() !== initialOverlay());
  const save = () =>
    void work.run(async () => {
      const body: unknown = overlay().trim() ? JSON.parse(overlay()) : null;
      if (body !== null && (typeof body !== 'object' || Array.isArray(body)))
        throw new Error(tr('Enter a JSON object.'));
      if (!name().trim()) throw new Error(tr('Enter a connection name.'));
      const config = { ...configuration() };
      if ('baseUrl' in config || baseUrl()) config.baseUrl = baseUrl().trim();
      if (supportsCompaction()) config.serverSideCompaction = compaction();
      const facts = detail();
      const result = facts
        ? await rpc.mutate('settings', 'update', {
            expected: connectionBasis(facts.target),
            changes: {
              name: name().trim(),
              enabled: enabled(),
              configuration: config,
              modelOverrides: facts.editing.modelOverrides,
              requestBodyOverlay: body as Record<string, unknown> | null,
            },
          })
        : await rpc.mutate('settings', 'create', {
            expectedCatalogRevision: (target as Extract<ConnectionTarget, { provider: Identity }>)
              .catalogRevision,
            connection: {
              slug: slug().trim(),
              name: name().trim(),
              enabled: enabled(),
              provider: provider()!.identity,
              configuration: config,
              enabledModelIds: [],
              ...(body ? { requestBodyOverlay: body as Record<string, unknown> } : {}),
            },
          });
      if (result.kind !== 'committed' || !result.connection) throw new Error(result.kind);
      connectionId = result.connection.connectionId;
      props.onChanged();
      await load();
    });
  const remove = async () => {
    const current = work.fence();
    const { action } = await AlertDialog.show({
      title: tr('Remove {name}?', { name: name() }),
      actions: [
        { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
        { id: 'remove', label: tr('Remove'), role: 'destructive' },
      ],
    });
    if (!current() || action !== 'remove') return;
    await work.run(async () => {
      const result = await rpc.mutate('settings', 'remove', {
        expected: connectionBasis(detail()!.target),
      });
      if (result.kind !== 'committed') throw new Error(result.kind);
      props.onChanged();
      if (work.canWrite()) props.onBack();
    });
  };
  const saveKey = (isUsage: boolean) => {
    const secret = isUsage
      ? JSON.stringify({
          accessKeyId: usageId().trim(),
          secretAccessKey: usageSecret(),
          ...(team().trim() ? { teamId: team().trim() } : {}),
        })
      : key();
    return work.run(async () => {
      await saveCredential(
        rpc,
        detail()!.target,
        (isUsage ? usage() : credential())!,
        secret,
        isUsage,
      );
      if (isUsage) {
        usageId.set('');
        usageSecret.set('');
        team.set('');
      } else key.set('');
      await load();
    }, tr('Could not save the credential.'));
  };
  const removeKey = (status: CredentialStatus) =>
    work.run(async () => {
      await deleteCredential(rpc, detail()!.target, status);
      await load();
    });
  const discover = () =>
    work.run(async () => {
      progress.set(tr('Discovering models…'));
      try {
        const result = await rpc.mutate('settingsSetup', 'discoverModels', detail()!.target);
        if (result.kind !== 'ready') throw new Error(result.kind);
        props.onChanged();
        await load();
      } finally {
        progress.set('');
      }
    });
  const authorize = (method: string) =>
    work.run(async () => {
      progress.set(tr('Waiting for provider sign-in…'));
      try {
        const result = await rpc.mutate(
          'settingsAuthentication',
          'loginCredential',
          {
            expected: detail()!.target,
            expectedCredential: credentialBasis(credential()),
            method,
          },
          {
            onProgress: ({ value }) => {
              const prompt = value as Partial<SettingsLoginPrompt>;
              const code = prompt?.userCode;
              if (
                work.canWrite() &&
                typeof prompt?.url === 'string' &&
                /^https?:\/\//i.test(prompt.url) &&
                typeof code === 'string'
              )
                login.set({ url: prompt.url, userCode: code });
            },
          },
        );
        if (result.kind !== 'saved') throw new Error(result.reason);
        await load();
      } finally {
        login.set(null);
        progress.set('');
      }
    });
  const deleteApiKey = async () => {
    const current = work.fence();
    const status = credential()!;
    if ((await confirmDeleteApiKey()) && current()) await removeKey(status);
  };
  const interactive = () =>
    provider()?.descriptor.authentication.filter((method) => method.interactive) ?? [];
  const afterApiKey = () => interactive().length > 0 || !!progress();
  const canOperate = () => !dirtyDetails() && !work.busy();
  const models = () => [
    ...new Set([
      ...(detail()?.editing.enabledModelIds ?? []),
      ...(detail()?.editing.discoveredModelIds ?? []),
      ...Object.keys(detail()?.editing.modelOverrides ?? {}),
    ]),
  ];
  effect(() => {
    props.version;
    untracked(reload);
  });
  // Re-read connection revisions after a model edit returns to this page.
  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={detail()?.name ?? tr('Connection')}
      work={work}
      ready={!!provider()}
      reload={reload}
      dirty={dirtyDetails() || !!key() || !!usageSecret()}
      save={dirtyDetails() ? save : undefined}
    >
      <InsetGroup header={tr('Connection')}>
        <GroupRow title={tr('Provider')} value={provider()?.descriptor.label} divider />
        <SettingField
          label={tr('Name')}
          value={name()}
          edit={name.set}
          disabled={work.busy()}
          divider
        />
        <If when={!detail()}>
          <SettingField
            label={tr('Connection ID')}
            value={slug()}
            edit={slug.set}
            disabled={work.busy()}
            divider
          />
        </If>
        <If when={provider()?.descriptor.customEndpoint || 'baseUrl' in configuration()}>
          <SettingField
            label={tr('Base URL')}
            value={baseUrl()}
            edit={baseUrl.set}
            keyboard="url"
            disabled={work.busy()}
            divider
          />
        </If>
        <SettingSwitch
          title={tr('Enabled')}
          checked={enabled()}
          change={enabled.set}
          disabled={work.busy()}
          divider={supportsCompaction()}
        />
        <If when={supportsCompaction()}>
          <SettingSwitch
            title={tr('Server-side compaction')}
            checked={compaction()}
            change={compaction.set}
            disabled={work.busy()}
          />
        </If>
      </InsetGroup>
      <If when={credential()}>
        <InsetGroup header={tr('API Key')}>
          <If when={provider()?.descriptor.authentication.some((method) => !method.interactive)}>
            <SettingField
              label={credential()?.configured ? tr('Replace API key') : tr('API Key')}
              value={key()}
              edit={key.set}
              secret
              disabled={!canOperate()}
              divider
            />
            <GroupRow
              title={tr('Save API key')}
              tone="primary"
              disabled={!canOperate() || !key().trim()}
              divider={!!credential()?.configured || afterApiKey()}
              onPress={() => void saveKey(false)}
            />
          </If>
          <If when={credential()?.configured}>
            <GroupRow
              title={tr('Delete API key')}
              tone="destructive"
              disabled={!canOperate()}
              divider={afterApiKey()}
              onPress={() => void deleteApiKey()}
            />
          </If>
          <Each of={interactive()} key={(method) => method.id}>
            {(method, index) => (
              <GroupRow
                title={method().label}
                tone="primary"
                disabled={!canOperate()}
                divider={index() < interactive().length - 1 || !!progress()}
                onPress={() => void authorize(method().id)}
              />
            )}
          </Each>
          <If when={progress()}>
            <GroupRow title={progress()} />
          </If>
          <If when={login()}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
              <Text style={{ ...type.mono, color: token('foreground') }}>{login()!.userCode}</Text>
              <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                {login()!.url}
              </Text>
            </View>
            <GroupRow
              title={tr('Copy code')}
              tone="primary"
              divider
              onPress={() => void Clipboard.writeText(login()!.userCode)}
            />
            <GroupRow
              title={tr('Open sign-in page')}
              tone="primary"
              onPress={() => void openUrl(login()!.url)}
            />
          </If>
        </InsetGroup>
      </If>
      <If when={usage()}>
        <InsetGroup header={tr('Usage credential')}>
          <SettingField
            label={tr('Access key ID')}
            value={usageId()}
            edit={usageId.set}
            secret
            disabled={!canOperate()}
            divider
          />
          <SettingField
            label={tr('Secret access key')}
            value={usageSecret()}
            edit={usageSecret.set}
            secret
            disabled={!canOperate()}
            divider
          />
          <If when={provider()?.descriptor.usageAuthentication === 'team_access_key'}>
            <SettingField
              label={tr('Team ID')}
              value={team()}
              edit={team.set}
              disabled={!canOperate()}
              divider
            />
          </If>
          <GroupRow
            title={tr('Save usage credential')}
            tone="primary"
            disabled={!canOperate() || !usageId() || !usageSecret()}
            divider={!!usage()?.configured}
            onPress={() => void saveKey(true)}
          />
          <If when={usage()?.configured}>
            <GroupRow
              title={tr('Delete usage credential')}
              tone="destructive"
              disabled={!canOperate()}
              onPress={() => void removeKey(usage()!)}
            />
          </If>
        </InsetGroup>
      </If>
      <If when={detail()}>
        <InsetGroup header={tr('Models')}>
          <If when={provider()?.descriptor.discovery}>
            <GroupRow
              title={tr('Discover models')}
              tone="primary"
              disabled={!canOperate()}
              divider={models().length > 0}
              onPress={() => void discover()}
            />
          </If>
          <Each of={models()} key={(id) => id}>
            {(id, index) => (
              <GroupRow
                title={detail()?.editing.modelOverrides?.[id()]?.displayName ?? id()}
                chevron
                divider={index() < models().length - 1}
                disabled={!canOperate()}
                onPress={() => props.openModel(detail()!.target.connectionId, detail()!.name, id())}
              />
            )}
          </Each>
        </InsetGroup>
        <InsetGroup>
          <GroupRow
            title={tr('Remove connection')}
            tone="destructive"
            disabled={!canOperate()}
            onPress={() => void remove()}
          />
        </InsetGroup>
      </If>
      <InsetGroup>
        <GroupRow
          title={tr('Advanced options')}
          value={advanced() ? tr('Hide') : tr('Show')}
          divider={advanced()}
          onPress={() => advanced.update((value) => !value)}
        />
        <If when={advanced()}>
          <SettingField
            label={tr('Request body overlay')}
            value={overlay()}
            edit={overlay.set}
            multiline
            disabled={work.busy()}
          />
        </If>
      </InsetGroup>
    </SettingsForm>
  );
}
