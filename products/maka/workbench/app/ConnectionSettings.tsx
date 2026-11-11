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

import {
  cleanup,
  computed,
  effect,
  inputAction,
  lifecycle,
  platform,
  signal,
  Text,
  untracked,
  View,
} from 'nsh';
import type { SettingsConnectionSummary } from '../../../../packages/plugin-sdk/src/index.js';
import type { ModelSettingsOwner } from './settings';
import { ConnectionAdvanced, ConnectionForm } from './ConnectionForm';
import { ProviderPicker } from './ProviderPicker';
import { ConnectionModel } from './ConnectionModel';
import { LoadingIndicator } from './Loading';
import { currentLocale, tr } from './locale';
import { useHost } from './host';
import { watchConnectionUsage, type UsageReading, type UsageResult } from './connectionUsage';
import {
  SettingsBody,
  SettingsConfirm,
  SettingsDiscard,
  SettingsLede,
  SettingsProblem,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  SettingsSelect,
} from './SettingsPage';
import { C, captionTextStyle } from './ui';

const choiceKey = (selection: { connectionId: string; modelId: string }) =>
  JSON.stringify([selection.connectionId, selection.modelId]);

export function ConnectionSettings(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  return (
    <If when={!owner.discardTarget()} else={<Discard owner={owner} />}>
      <If when={!owner.confirmation()} else={<Removal owner={owner} />}>
        <If when={owner.page() === 'connections'}>
          <ConnectionList owner={owner} />
        </If>
        <If when={owner.page() === 'providers'}>
          <ProviderPicker owner={owner} />
        </If>
        <If when={owner.page() === 'connection' && owner.editor()}>
          <ConnectionForm settings={owner} />
        </If>
        <If when={owner.page() === 'advanced' && owner.editor()}>
          <ConnectionAdvanced settings={owner} />
        </If>
        <If when={owner.page() === 'model' && owner.editor() && owner.model()}>
          <ConnectionModel settings={owner} />
        </If>
      </If>
    </If>
  );
}

function ConnectionList(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  const unavailable = () => owner.busy() || !owner.pendingKnown() || owner.pending().length > 0;
  const current = () => {
    const model = owner.defaultModel();
    return model?.kind === 'ready'
      ? choiceKey(model.choice.selection)
      : model?.kind === 'unavailable'
        ? choiceKey(model.target)
        : '';
  };
  const choices = () => [
    { value: '', title: tr('None') },
    ...owner.modelChoices().map((choice) => ({
      value: choiceKey(choice.selection),
      title: choice.label,
      group: choice.connectionName,
    })),
  ];
  const empty = () =>
    !owner.loading() &&
    !owner.error() &&
    !owner.connections().length &&
    !owner.connectionQuery().trim();
  return (
    <SettingsBody>
      <If when={empty()}>
        <SettingsLede>{tr('Add your first connection, then fetch or add a model.')}</SettingsLede>
      </If>
      <If when={owner.connections().length > 0}>
        <SettingsSection>
          <SettingsSelect
            label={tr('Default model')}
            description={tr('Used for new conversations.')}
            value={current()}
            choices={choices()}
            disabled={unavailable() || owner.loading()}
            placeholder={
              owner.defaultModel()?.kind === 'unavailable' ? tr('Unavailable') : tr('None')
            }
            change={(value) => {
              const choice = owner
                .modelChoices()
                .find((item) => choiceKey(item.selection) === value);
              void owner.setDefault(choice?.selection ?? null);
            }}
          />
        </SettingsSection>
      </If>
      <If when={owner.connections().length > 8 || owner.connectionQuery().trim()}>
        <SettingsSearch
          label={tr('Search connections')}
          value={owner.connectionQuery()}
          change={owner.searchConnections}
        />
      </If>
      <If when={owner.connections().length > 0}>
        <SettingsSection title={tr('Connections')}>
          <Each of={owner.filteredConnections()} key={(item) => item.basis.connectionId}>
            {(item) => (
              <SettingsRow
                label={item().name}
                accessibilityLabel={tr('Edit connection {name}', { name: item().name })}
                tone={item().enabled ? undefined : 'muted'}
                description={
                  item().enabled
                    ? tr('{count} models', { count: item().enabledModelCount })
                    : tr('Disabled')
                }
                status={
                  item().enabled && item().enabledModelCount === 0 ? tr('No models') : undefined
                }
                leading={<Monogram name={item().name} muted={!item().enabled} />}
                detail={
                  <If when={item().enabled && item().usageLimits}>
                    <ConnectionUsageLimits connection={item} />
                  </If>
                }
                opens
                disabled={unavailable() || !item().editable}
                onPress={inputAction(owner.openConnection, item().basis)}
              />
            )}
          </Each>
          <If when={!owner.filteredConnections().length && !owner.loading()}>
            <SettingsRow label={tr('No matching connections.')} tone="muted" />
          </If>
          <If when={owner.next() !== null && !owner.error()}>
            <SettingsRow
              label={tr('Show more')}
              tone="muted"
              disabled={owner.loading()}
              onPress={() => void owner.loadConnections(true)}
            />
          </If>
        </SettingsSection>
      </If>
      <Status owner={owner} retry={() => void owner.loadConnections()} />
    </SettingsBody>
  );
}

function usageWindow(seconds: number) {
  if (seconds === 604800) return tr('Weekly limit');
  const units = [
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const;
  const [unit, size] = units.find(([, size]) => seconds % size === 0) ?? units[4];
  return tr('{duration} limit', {
    duration: new Intl.NumberFormat(currentLocale(), { style: 'unit', unit }).format(
      seconds / size,
    ),
  });
}

type Limit = Extract<UsageResult, { kind: 'ready' }>['limits'][number];

function usageNumber(value: number) {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(value);
}

function usageLabel(limit: Limit) {
  if (limit.kind === 'balance') return limit.label ?? tr('Balance');
  if (limit.kind === 'unlimited') return limit.label ?? tr('Usage limit');
  const period =
    limit.period?.kind === 'monthly'
      ? tr('Monthly limit')
      : limit.period?.kind === 'duration'
        ? usageWindow(limit.period.seconds)
        : '';
  return [limit.label, period].filter(Boolean).join(' · ') || tr('Usage limit');
}

function usageValue(limit: Limit) {
  if (limit.kind === 'balance')
    return [usageNumber(limit.amount), limit.unit].filter(Boolean).join(' ');
  if (limit.kind === 'unlimited') return tr('Unlimited');
  const percent = tr('{percent}% used', { percent: usageNumber(limit.usedPercent) });
  if (!limit.quantity) return percent;
  const { used, limit: total, unit } = limit.quantity;
  return `${percent} · ${usageNumber(used)} / ${usageNumber(total)}${unit ? ` ${unit}` : ''}`;
}

function ConnectionUsageLimits(props: { connection: () => SettingsConnectionSummary }) {
  const host = useHost();
  const usage = signal<UsageReading | null>(null);
  const revision = computed(() => props.connection().basis.revision);
  const connectionId = untracked(() => props.connection().basis.connectionId);
  let lastRevision: number | undefined;
  let stop: (() => void) | undefined;
  cleanup(() => stop?.());
  effect(() => {
    const current = revision();
    stop?.();
    stop = undefined;
    if (current !== lastRevision) usage.set(null);
    lastRevision = current;
    if (lifecycle() !== 'active') return;
    stop = watchConnectionUsage(
      () => host.query('settings', 'connectionUsageLimits', { connectionId, revision: current }),
      (reading) => usage.set(reading),
      untracked(usage),
    );
  });
  const limits = () => {
    const result = usage()?.result;
    return result?.kind === 'ready' ? result.limits : [];
  };
  const message = () => {
    if (usage()?.refreshFailed) return tr('Last usage refresh failed');
    switch (usage()?.result.kind) {
      case 'ready':
        return limits().length ? '' : tr('No usage limits reported');
      case 'unsupported':
        return '';
      case 'authentication_required':
        return tr('Update the connection credential to see usage limits');
      case 'usage_credential_required':
        return tr('Add or update the usage access key');
      case 'unavailable':
      case 'superseded':
        return tr('Usage limits unavailable');
      default:
        return tr('Loading usage limits…');
    }
  };
  const terminal = platform.idiom === 'terminal';
  return (
    <View style={{ gap: terminal ? 0 : 6, marginTop: terminal ? 0 : 4 }}>
      <If when={message()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{message()}</Text>
      </If>
      <Each of={limits()}>
        {(entry) => {
          const reset = () => {
            const limit = entry();
            const timestamp = limit.kind === 'window' ? limit.resetsAt : null;
            return timestamp == null
              ? ''
              : tr('Resets {time}', {
                  time: new Date(timestamp * 1000).toLocaleString(currentLocale(), {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  }),
                });
          };
          const used = () => {
            const limit = entry();
            return limit.kind === 'window' ? limit.usedPercent : null;
          };
          return (
            <View style={{ gap: terminal ? 0 : 3 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {usageLabel(entry())} · {usageValue(entry())}
              </Text>
              <If when={!terminal && used() !== null}>
                <View style={{ height: 3, borderRadius: 2, backgroundColor: C.line }}>
                  <View
                    style={{
                      width: `${Math.min(100, used() ?? 0)}%`,
                      height: 3,
                      borderRadius: 2,
                      backgroundColor: (used() ?? 0) >= 100 ? C.warning : C.accent,
                    }}
                  />
                </View>
              </If>
              <If when={reset()}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>{reset()}</Text>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function Monogram(props: { name: string; muted: boolean }) {
  return (
    <If when={platform.idiom !== 'terminal'}>
      <View
        style={[
          {
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: C.raised,
            alignItems: 'center',
            justifyContent: 'center',
          },
          { pointerEvents: 'none' },
        ]}
      >
        <Text
          style={{
            fontSize: 13,
            lineHeight: 16,
            fontWeight: '600',
            color: props.muted ? C.muted : C.secondary,
          }}
        >
          {Array.from(props.name.trim())[0]?.toUpperCase() ?? '?'}
        </Text>
      </View>
    </If>
  );
}

export function Status(props: { owner: ModelSettingsOwner; retry(): void }) {
  return (
    <>
      <If when={props.owner.loading()}>
        <LoadingIndicator label={tr('Loading settings…')} />
      </If>
      <If when={!props.owner.loading() && props.owner.error()}>
        <SettingsProblem retry={props.retry} />
      </If>
    </>
  );
}

function Discard(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  return (
    <SettingsDiscard
      name={
        owner.discardTarget() === 'model'
          ? owner.model()?.label || owner.model()?.id
          : owner.editor()?.name
      }
      onDiscard={inputAction(owner.discardEdits, owner.action())}
      onKeep={owner.keepEditing}
    />
  );
}

function Removal(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  const kind = () => owner.confirmation();
  const name = () =>
    kind() === 'model'
      ? owner.model()?.label.trim() || owner.model()?.originalId || ''
      : owner.editor()?.name || '';
  const interactive = () =>
    owner.editor()?.provider.descriptor.authentication.some((method) => method.interactive);
  const label = () =>
    kind() === 'connection'
      ? tr('Delete connection')
      : kind() === 'key'
        ? interactive()
          ? tr('Sign out')
          : tr('Remove stored provider credential')
        : tr('Remove model');
  return (
    <SettingsConfirm
      title={tr('{action}: {name}', { action: label(), name: name() })}
      body={
        kind() === 'connection'
          ? tr(
              'Delete this connection, its stored provider credential and model settings? Existing conversations keep their saved selection.',
            )
          : kind() === 'key'
            ? tr('Remove the stored provider credential? This connection may stop working.')
            : tr('Remove this model from the connection?')
      }
      confirm={label()}
      destructive
      disabled={owner.busy() || owner.loading()}
      onConfirm={inputAction(owner.remove, owner.removalAction())}
      onCancel={inputAction(owner.cancelRemoval, owner.removalAction())}
    />
  );
}
