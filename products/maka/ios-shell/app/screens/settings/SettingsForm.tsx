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

import { platform, safeAreaInsets, Scroll, Text, View, token, type JSX } from 'nsh';
import { AlertDialog, Input, MenuButton, NavPage, Switch as BaseSwitch } from 'nsh/base';
import { isAvailable, Switch as NativeSwitch } from 'nsh/mobile';
import { tr } from '../../locale';
import { hostById } from '../../state/hostPool';
import type { SettingsWork } from '../../state/settings/rpc';
import { type } from '../../theme/tokens';
import { ActionButton, BannerNotice, GroupDivider, GroupRow, ScreenHeader } from '../../ui';

export interface SettingsPageProps {
  rootId: string;
  onBack: () => void;
  backLabel?: string;
  active?: () => boolean;
}

export function SettingsForm(
  props: SettingsPageProps & {
    title: string;
    work: SettingsWork;
    ready: boolean;
    reload: () => void;
    dirty?: boolean;
    save?: () => void;
    children?: JSX.Element;
  },
) {
  const insets = safeAreaInsets();
  const back = async () => {
    if (!props.dirty) return props.onBack();
    const current = props.work.fence();
    const { action } = await AlertDialog.show({
      title: tr('Discard changes?'),
      actions: [
        { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
        { id: 'discard', label: tr('Discard'), role: 'destructive' },
      ],
    });
    if (current() && action === 'discard') props.onBack();
  };
  const backLabel = () => props.backLabel ?? hostById(props.rootId)?.hostName ?? tr('Settings');
  return (
    <NavPage
      title={props.title}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      popOnBack={!props.dirty}
      onBackPress={() => {
        if (props.dirty) void back();
      }}
      ios={{
        headerRightItems: props.save
          ? [
              {
                key: 'save',
                label: tr('Save'),
                disabled: !props.ready || props.work.busy() || props.dirty === false,
                onPress: props.save,
              },
            ]
          : [],
      }}
      header={
        <ScreenHeader title={props.title} backLabel={backLabel()} onBack={() => void back()} />
      }
      style={{ flex: 1 }}
    >
      <Scroll
        style={{ flex: 1, backgroundColor: token('grouped-bg') }}
        contentStyle={{ paddingTop: 16, paddingBottom: Math.max(insets().bottom, 20) + 24 }}
      >
        <If when={props.work.error()}>
          <BannerNotice
            title={props.work.error()}
            tone="destructive"
            actionLabel={!props.ready ? tr('Retry') : undefined}
            onAction={!props.ready ? props.reload : undefined}
          />
        </If>
        <If when={!props.ready && !props.work.busy() && !props.work.error()}>
          <BannerNotice
            title={tr('Unavailable')}
            actionLabel={tr('Retry')}
            onAction={props.reload}
          />
        </If>
        <If when={props.work.busy()}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
              {props.ready ? tr('Working…') : tr('Loading…')}
            </Text>
          </View>
        </If>
        <If when={props.ready}>
          {props.children}
          <If when={platform.os !== 'ios' && props.save}>
            <View style={{ paddingHorizontal: 16 }}>
              <ActionButton
                title={tr('Save')}
                disabled={props.work.busy() || props.dirty === false}
                onPress={() => props.save?.()}
              />
            </View>
          </If>
        </If>
      </Scroll>
    </NavPage>
  );
}

export function SettingField(props: {
  label: string;
  value: string;
  placeholder?: string;
  edit: (value: string) => void;
  multiline?: boolean;
  secret?: boolean;
  disabled?: boolean;
  keyboard?: 'number-pad' | 'url';
  divider?: boolean;
}) {
  return (
    <View>
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 6,
        }}
      >
        <Text style={{ ...type.footnote, color: token('muted-foreground') }}>{props.label}</Text>
        <Input
          accessibilityLabel={props.label}
          value={props.value}
          placeholder={props.placeholder}
          multiline={props.multiline}
          masked={props.secret}
          disabled={props.disabled}
          keyboardType={props.keyboard}
          onChange={({ value }) => props.edit(value)}
          style={{
            ...(props.multiline ? type.mono : type.body),
            minHeight: props.multiline ? 110 : 34,
            color: token('foreground'),
          }}
        />
      </View>
      <If when={props.divider}>
        <GroupDivider inset={16} />
      </If>
    </View>
  );
}

export function SettingSwitchControl(props: {
  accessibilityLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <If
      when={isAvailable}
      else={
        <BaseSwitch
          accessibilityLabel={props.accessibilityLabel}
          checked={props.checked}
          disabled={props.disabled}
          onChange={({ checked }) => props.onChange(checked)}
          hitSlop={6}
          style={{
            flexShrink: 0,
            borderRadius: 9999,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: props.disabled ? 0.45 : 1,
          }}
          trackClass="w-[44px] h-[26px] p-[2px] rounded-full flex-row items-center checked:justify-end"
          trackStyle={{
            backgroundColor: props.checked ? token('success') : token('surface-muted'),
          }}
          thumbClass="size-[22px] rounded-full"
          thumbStyle={{ backgroundColor: token('primary-foreground') }}
        />
      }
    >
      <NativeSwitch
        accessibilityLabel={props.accessibilityLabel}
        checked={props.checked}
        disabled={props.disabled}
        onChange={({ checked }) => props.onChange(checked)}
        style={{ accentColor: token('success') }}
      />
    </If>
  );
}

export function SettingSwitch(props: {
  title: string;
  checked: boolean;
  disabled?: boolean;
  divider?: boolean;
  change: (checked: boolean) => void;
}) {
  return (
    <GroupRow
      title={props.title}
      disabled={props.disabled}
      divider={props.divider}
      accessible={false}
      trailing={
        <SettingSwitchControl
          accessibilityLabel={props.title}
          checked={props.checked}
          disabled={props.disabled}
          onChange={props.change}
        />
      }
    />
  );
}

export function SettingChoice<T extends string>(props: {
  title: string;
  value: T;
  options: readonly { id: T; label: string }[];
  disabled?: boolean;
  divider?: boolean;
  change: (value: T) => void;
}) {
  return (
    <MenuButton
      title={props.title}
      accessibilityLabel={props.title}
      disabled={props.disabled}
      items={props.options.map((option) => ({
        ...option,
        checked: option.id === props.value,
        singleSelection: true,
      }))}
      onSelect={({ id }) => {
        const option = props.options.find((item) => item.id === id);
        if (option) props.change(option.id);
      }}
    >
      <GroupRow
        title={props.title}
        value={props.options.find((item) => item.id === props.value)?.label ?? props.value}
        divider={props.divider}
        chevron
        disabled={props.disabled}
      />
    </MenuButton>
  );
}

export function SettingStatus(props: {
  label: string;
  tone: 'success' | 'warning' | 'destructive' | 'muted-foreground';
}) {
  return (
    <Text style={{ ...type.footnote, color: token(props.tone), flexShrink: 1, numberOfLines: 1 }}>
      {props.label}
    </Text>
  );
}

export async function confirmDeleteApiKey() {
  const { action } = await AlertDialog.show({
    title: tr('Delete API key'),
    actions: [
      { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
      { id: 'delete', label: tr('Delete'), role: 'destructive' },
    ],
  });
  return action === 'delete';
}

export async function confirmSettingAction(
  title: string,
  label: string,
  destructive = true,
  description?: string,
) {
  const { action } = await AlertDialog.show({
    title,
    description,
    actions: [
      { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
      { id: 'accept', label, role: destructive ? 'destructive' : 'default' },
    ],
  });
  return action === 'accept';
}
