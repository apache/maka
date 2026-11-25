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

import { safeAreaInsets, Scroll, Text, View, token } from 'nsh';
import { AlertDialog, Input, MenuButton, NavPage } from 'nsh/base';
import { Switch } from 'nsh/mobile';
import { tr } from '../../locale';
import { hostById } from '../../state/hostPool';
import type { SettingsWork } from '../../state/settings/rpc';
import { type } from '../../theme/tokens';
import { BannerNotice, GroupRow, ScreenHeader } from '../../ui';

export interface SettingsPageProps {
  rootId: string;
  onBack: () => void;
  backLabel?: string;
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
    const { action } = await AlertDialog.show({
      title: tr('Discard changes?'),
      actions: [
        { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
        { id: 'discard', label: tr('Discard'), role: 'destructive' },
      ],
    });
    if (action === 'discard') props.onBack();
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
        keyboardDismissMode="interactive"
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
        <If when={props.work.busy()}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
              {props.ready ? tr('Working…') : tr('Loading…')}
            </Text>
          </View>
        </If>
        <If when={props.ready}>
          {props.children}
          <If when={props.save}>
            <View style={{ paddingHorizontal: 16 }}>
              <GroupRow
                title={tr('Save')}
                tone="primary"
                disabled={props.work.busy() || props.dirty === false}
                onPress={props.save}
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
  edit: (value: string) => void;
  multiline?: boolean;
  secret?: boolean;
  disabled?: boolean;
  keyboard?: 'number-pad' | 'url';
  divider?: boolean;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 6,
        borderBottomWidth: props.divider ? 0.5 : 0,
        borderBottomColor: token('separator'),
      }}
    >
      <Text style={{ ...type.footnote, color: token('muted-foreground') }}>{props.label}</Text>
      <Input
        accessibilityLabel={props.label}
        value={props.value}
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
      trailing={
        <Switch
          accessibilityLabel={props.title}
          checked={props.checked}
          disabled={props.disabled}
          onChange={({ checked }) => props.change(checked)}
          style={{ accentColor: token('success') }}
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
        chevron
        disabled={props.disabled}
      />
    </MenuButton>
  );
}
