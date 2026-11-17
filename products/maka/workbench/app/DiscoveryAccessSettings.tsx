/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { cleanup, signal, Scroll, Text, View } from 'nsh';
import type {
  AgentSchedules,
  DiscoveryExclusion,
  DiscoveryExclusions,
  DiscoveryToolGroup,
  DiscoveryToolGroups,
  ServiceMethods,
} from '../../../../packages/plugin-sdk/src/index.js';
import { sameValue } from '../../../../plugins/shared/value';
import type { DiscoveryWorkerTools } from './discoveryCore';
import type { Host } from './host';
import { tr, type MessageKey } from './locale';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsField } from './SettingsField';
import { SettingsButton, SettingsSegmented, SettingsSwitch } from './SettingsPage';
import { errorText, message, renderText, type UiText } from './text';
import { C, captionTextStyle } from './ui';

const groups = [
  ['read_files', 'readFiles', 'Discovery read files', 'Discovery read files detail'],
  ['read_history', 'readHistory', 'Discovery read history', 'Discovery read history detail'],
  ['modify_files', 'modifyFiles', 'Discovery modify files', 'Discovery modify files detail'],
  ['run_commands', 'runCommands', 'Discovery run commands', 'Discovery run commands detail'],
  ['network', 'network', 'Discovery network', 'Discovery network detail'],
  [
    'manage_sessions',
    'manageSessions',
    'Discovery manage sessions',
    'Discovery manage sessions detail',
  ],
  ['extensions', 'extensions', 'Discovery extensions', 'Discovery extensions detail'],
  ['desktop', 'desktop', 'Discovery desktop', 'Discovery desktop detail'],
] as const satisfies ReadonlyArray<
  readonly [DiscoveryToolGroup, keyof DiscoveryToolGroups, MessageKey, MessageKey]
>;

type ToolPreview = Extract<AgentSchedules, { kind: 'discovery_tools' }>;

function groupsFor(value: DiscoveryWorkerTools): DiscoveryToolGroups {
  if (typeof value !== 'string') return value.custom;
  const all = value === 'session';
  return {
    readFiles: true,
    readHistory: true,
    modifyFiles: all,
    runCommands: all,
    network: all,
    manageSessions: all,
    extensions: all,
    desktop: all,
  };
}

export function DiscoveryPermissionsEditor(props: {
  value: DiscoveryWorkerTools;
  preview: ToolPreview | null;
  disabled: boolean;
  change(value: DiscoveryWorkerTools): void;
}) {
  const more = signal(false);
  const details = signal(false);
  const granted = () => new Set(props.preview?.names ?? []);
  const offered = (group: DiscoveryToolGroup) =>
    props.preview?.options.filter((option) => option.group === group) ?? [];
  const activeGroups = () => groupsFor(props.value);
  const extraEnabled = () =>
    groups
      .slice(5)
      .filter(
        ([group, key]) => activeGroups()[key] && offered(group).some((tool) => tool.available),
      ).length;
  const change = (key: keyof DiscoveryToolGroups) => {
    const next = { ...activeGroups(), [key]: !activeGroups()[key] };
    if (key === 'readFiles' && !next.readFiles) {
      next.modifyFiles = false;
      next.runCommands = false;
    }
    if (next.modifyFiles || next.runCommands) next.readFiles = true;
    props.change({ custom: next });
  };
  return (
    <View style={{ gap: 6 }}>
      <SettingsSegmented
        label={tr('Discovery permissions')}
        value={typeof props.value === 'string' ? props.value : null}
        choices={[
          { value: 'read_only', title: tr('Use read-only investigation tools') },
          { value: 'session', title: tr('Use standard Session tools') },
        ]}
        change={(value) => props.change(value === 'session' ? 'session' : 'read_only')}
        disabled={props.disabled}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        <SettingsButton
          label={
            more()
              ? tr('Hide more discovery permissions')
              : extraEnabled()
                ? tr('More discovery permissions enabled', { count: extraEnabled() })
                : tr('More discovery permissions')
          }
          tone="quiet"
          onPress={() => more.set(!more())}
        />
        <If when={props.preview}>
          <SettingsButton
            label={tr(details() ? 'Hide discovery tool details' : 'View discovery tool details')}
            tone="quiet"
            onPress={() => details.set(!details())}
          />
        </If>
      </View>
      <Each of={groups} key={(group) => group[0]}>
        {(group, index) => {
          const available = () =>
            group()[0] === 'read_history' || offered(group()[0]).some((tool) => tool.available);
          return (
            <If when={index() < 5 || more()}>
              <SettingsSwitch
                label={tr(group()[2])}
                description={tr(group()[3])}
                checked={available() && activeGroups()[group()[1]]}
                disabled={props.disabled || !props.preview || !available()}
                status={
                  !available() && offered(group()[0]).length
                    ? tr('Discovery unavailable')
                    : undefined
                }
                onPress={() => change(group()[1])}
              />
            </If>
          );
        }}
      </Each>
      <If when={details() && props.preview}>
        <View style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 4 }}>
          <Each of={groups} key={(group) => group[0]}>
            {(group) => {
              const allowed = () => offered(group()[0]).filter((tool) => granted().has(tool.name));
              const unavailable = () => offered(group()[0]).filter((tool) => !tool.available);
              return (
                <If when={allowed().length + unavailable().length > 0}>
                  <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
                    {tr(group()[2])} ·{' '}
                    {allowed()
                      .map((tool) => tool.name)
                      .join(', ')}
                    {unavailable().length
                      ? (allowed().length ? ' · ' : '') +
                        tr('Discovery unavailable') +
                        ' · ' +
                        unavailable()
                          .map((tool) => tool.name)
                          .join(', ')
                      : ''}
                  </Text>
                </If>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}

type ExclusionKind = DiscoveryExclusion['kind'];
const exclusionLabels: Record<ExclusionKind, MessageKey> = {
  directory: 'Discovery exclude directory',
  file: 'Discovery exclude file',
  suffix: 'Discovery exclude suffix',
};
const exclusionValue = (entry: DiscoveryExclusion) =>
  entry.kind === 'suffix' ? entry.suffix : entry.path;

export function DiscoveryExclusionsEditor(props: {
  host: Host;
  sessionId: string;
  control(method: string, input: unknown): Promise<any>;
  close(): void;
}) {
  const original = signal<DiscoveryExclusions | null>(null);
  const draft = signal<DiscoveryExclusion[]>([]);
  const kind = signal<ExclusionKind>('directory');
  const value = signal('');
  const busy = signal(false);
  const error = signal<UiText>('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const load = async () => {
    busy.set(true);
    try {
      const result = await props.host.query('agent', 'schedules', {
        kind: 'discovery_exclusions',
        sessionId: props.sessionId,
      });
      if (!alive) return;
      if (result.kind !== 'discovery_exclusions') throw new Error('discovery_settings_unavailable');
      original.set(result.exclusions);
      draft.set(result.exclusions.entries);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not load discovery exclusions.'));
    } finally {
      if (alive) busy.set(false);
    }
  };
  void load();
  const add = () => {
    const text = value().trim();
    if (!text) return;
    const type = kind();
    const entry: DiscoveryExclusion =
      type === 'suffix' ? { kind: type, suffix: text } : { kind: type, path: text };
    if (!draft().some((existing) => sameValue(existing, entry))) draft.set([...draft(), entry]);
    value.set('');
    error.set('');
  };
  const save = async () => {
    if (!original() || busy()) return;
    busy.set(true);
    error.set('');
    try {
      const result: ServiceMethods['agent']['changeDiscoveryExclusions']['output'] =
        await props.control('changeDiscoveryExclusions', {
          entries: draft(),
          revision: original()!.revision ?? null,
          sessionId: props.sessionId,
        });
      if (!alive) return;
      if (result.kind === 'committed') props.close();
      else {
        if (result.kind === 'conflict') {
          await load();
          if (alive) error.set(message('Discovery exclusions changed'));
        } else {
          error.set(message('Discovery exclusions investigation running'));
        }
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not save discovery exclusions.'));
    } finally {
      if (alive) busy.set(false);
    }
  };
  const close = () => {
    if (!busy()) props.close();
  };
  return (
    <ModalDialog size="form" onCancel={close}>
      <DialogHeader title={tr('Discovery exclusions')} detail={tr('Discovery exclusions detail')} />
      <Scroll style={{ minHeight: 0, flexShrink: 1 }} contentStyle={{ gap: 12 }}>
        <If when={original()}>
          <If when={!draft().length}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('No discovery exclusions')}
            </Text>
          </If>
          <Each of={draft()} key={(entry) => entry.kind + '\u0000' + exclusionValue(entry)}>
            {(entry, index) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ ...captionTextStyle, color: C.text }}>
                    {tr(exclusionLabels[entry().kind])}
                  </Text>
                  <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
                    {exclusionValue(entry())}
                  </Text>
                </View>
                <SettingsButton
                  label={tr('Remove')}
                  accessibilityLabel={tr('Discovery remove exclusion', {
                    path: exclusionValue(entry()),
                  })}
                  icon="trash"
                  iconOnly
                  tone="quiet"
                  disabled={busy()}
                  onPress={() => draft.set(draft().filter((_, i) => i !== index()))}
                />
              </View>
            )}
          </Each>
          <SettingsSegmented
            label={tr('Discovery add exclusion')}
            value={kind()}
            choices={(['directory', 'file', 'suffix'] as const).map((key) => ({
              value: key,
              title: tr(exclusionLabels[key]),
            }))}
            change={(key) => {
              if (key === 'directory' || key === 'file' || key === 'suffix') {
                kind.set(key);
                value.set('');
              }
            }}
            disabled={busy()}
          />
          <SettingsField
            label={tr(kind() === 'suffix' ? 'Discovery file suffix' : 'Discovery exclusion path')}
            value={value()}
            change={value.set}
            placeholder={kind() === 'suffix' ? '.pem' : undefined}
            disabled={busy()}
          />
          <View style={{ alignItems: 'flex-end' }}>
            <SettingsButton
              label={tr('Discovery add exclusion entry')}
              icon="plus"
              disabled={busy() || !value().trim()}
              onPress={add}
            />
          </View>
        </If>
        <If when={busy() && !original()}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading…')}</Text>
        </If>
        <If when={error()}>
          <Text style={{ ...captionTextStyle, color: C.danger }}>{renderText(error())}</Text>
        </If>
      </Scroll>
      <DialogFooter>
        <SettingsButton label={tr('Cancel')} onPress={close} disabled={busy()} />
        <SettingsButton
          label={tr('Save')}
          tone="primary"
          onPress={() => void save()}
          disabled={
            busy() || !original() || !!value().trim() || sameValue(original()?.entries, draft())
          }
        />
      </DialogFooter>
    </ModalDialog>
  );
}
