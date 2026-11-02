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
  effect,
  inputAction,
  signal,
  Text,
  View,
  windowSize,
  type Signal,
  type JSX,
} from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type {
  UiContext,
  UiContributionRef,
  UiHost,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import type {
  SettingsPageInput,
  SettingsPageNavigation,
  SettingsRoute,
  SettingsViewInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { sameValue } from '../../../../plugins/shared/value';
import type { SettingsOperations } from './settingsOperations';
import { contributionTitle } from './plugins/context';
import { Icon } from './Icon';
import { tr } from './locale';
import { dialogTop } from './chrome';
import {
  C,
  compact,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  textTooltip,
} from './ui';

type Registration = { key: string; value: SettingsPageNavigation };
type BackAction = { key: string | null; navigation: string | null };
const matches = (item: UiContributionRef, route: SettingsRoute | null) =>
  route !== null && item.id === route.id && sameValue(item.instance.instance, route.instance);

// Page navigation is registered by the rendered contribution. The dialog owns
// focus and the original journal; pages own their forms and unsaved drafts.
export function ModelSettings(props: {
  context: UiContext<UiHost, JSX.Element>;
  input: SettingsViewInput;
  route: Signal<SettingsRoute | null>;
  defaultRoute: SettingsRoute;
  operations: SettingsOperations;
}) {
  const runtime = props.context.runtime;
  const operations = props.operations;
  const navigation = signal<Registration | null>(null);
  const rail = () => windowSize().width >= 880 && !compact();
  const contributed = () => runtime.settings().find((item) => matches(item, props.route()));
  const page = () => {
    const registered = navigation();
    return registered && registered.key === contributed()?.key ? registered.value : null;
  };
  const busy = () => operations.busy() || (page()?.busy?.() ?? false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  effect(() => {
    if (!runtime.ready() || contributed()) return;
    const fallback =
      runtime.settings().find((item) => matches(item, props.defaultRoute)) ?? runtime.settings()[0];
    props.route.set(fallback ? { instance: fallback.instance.instance, id: fallback.id } : null);
  });
  const choose = (request: { from: string | null; to: string }) => {
    if (
      !alive ||
      busy() ||
      (contributed()?.key ?? null) !== request.from ||
      request.from === request.to
    )
      return;
    const target = runtime.settings().find((item) => item.key === request.to);
    if (!target) return;
    if (!operations.pending().length) {
      operations.error.set('');
      operations.notice.set('');
    }
    props.route.set({ instance: target.instance.instance, id: target.id });
  };
  const backAction = (): BackAction => ({
    key: contributed()?.key ?? null,
    navigation: page()?.navigation() ?? null,
  });
  const back = (request: BackAction) => {
    if (
      !alive ||
      busy() ||
      request.key !== (contributed()?.key ?? null) ||
      request.navigation !== (page()?.navigation() ?? null)
    )
      return;
    if (page()?.back() ?? true) props.input.close();
  };
  const cancel = (request: BackAction) => () => back(request);
  const close = () => {
    if (alive && !busy()) props.input.close();
  };
  const input = (contribution: UiContributionRef): SettingsPageInput => ({
    settings: {
      attach(value) {
        const registration = { key: contribution.key, value };
        navigation.set(registration);
        return () => {
          if (navigation() === registration) navigation.set(null);
        };
      },
    },
  });
  const title = () =>
    page()?.title() ?? (contributed() ? contributionTitle(contributed()!) : tr('Settings'));
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={cancel(backAction())}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        paddingTop: dialogTop(16),
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 880,
          height: '100%',
          maxHeight: 800,
          minHeight: 0,
          backgroundColor: C.surface,
          borderRadius: compact() ? 12 : 24,
          borderWidth: 1,
          borderColor: C.line,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: compact() ? 48 : 64,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
          }}
        >
          <If when={page()?.nested() ?? false}>
            <Button
              disabled={busy()}
              accessibilityLabel={page()?.backLabel?.() ?? tr('Back')}
              tooltip={textTooltip(() => tr('Back'))}
              onPress={inputAction(back, backAction())}
              style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="back" color={C.secondary} />
            </Button>
          </If>
          <Text style={{ flex: 1, color: C.text, fontWeight: '600', fontSize: 18, lineHeight: 24 }}>
            {title()}
          </Text>
          <Button
            disabled={busy()}
            accessibilityLabel={tr('Close settings')}
            tooltip={textTooltip(() => tr('Close settings'))}
            onPress={inputAction(close, null)}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </View>
        <View style={{ flex: 1, minHeight: 0, flexDirection: rail() ? 'row' : 'column' }}>
          <View
            style={{
              flexDirection: rail() ? 'column' : 'row',
              flexWrap: rail() ? 'nowrap' : 'wrap',
              width: rail() ? 184 : '100%',
              flexShrink: 0,
              padding: rail() ? 16 : 8,
              gap: 4,
              borderRightWidth: rail() ? 1 : 0,
              borderRightColor: C.line,
            }}
          >
            <Each of={runtime.settings()} key={(item) => item.key}>
              {(item) => (
                <Button
                  accessibilityLabel={tr('Settings section {section}', {
                    section: contributionTitle(item()),
                  })}
                  disabled={busy()}
                  selected={contributed()?.key === item().key}
                  onPress={inputAction(choose, {
                    from: contributed()?.key ?? null,
                    to: item().key,
                  })}
                  style={{ ...controlStyle, minHeight: rail() ? 40 : 32 }}
                  selectedStyle={{ backgroundColor: C.raised }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: contributed()?.key === item().key ? C.text : C.muted,
                    }}
                  >
                    {contributionTitle(item())}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
          <View
            style={{ flex: 1, minWidth: 0, minHeight: 0, padding: compact() ? 8 : 16, gap: 16 }}
          >
            <If when={operations.error()}>
              <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
                {operations.error()}
              </Text>
            </If>
            <If when={operations.notice()}>
              <Text style={{ ...bodyTextStyle, color: C.muted }}>{operations.notice()}</Text>
            </If>
            <If when={operations.pending().length > 0}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Checking action status…')}
              </Text>
            </If>
            <Each of={contributed() ? [contributed()!] : []} key={(item) => item.key}>
              {(item) => runtime.render(item(), { sessionId: null, input: input(item()) })}
            </Each>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
