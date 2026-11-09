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
  host as surfaceHost,
  inputAction,
  platform,
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
import { SettingsButton, settingsGutter, settingsInset } from './SettingsPage';
import {
  C,
  compact,
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
  const sections = () =>
    runtime
      .settings()
      .filter((item) => item.id !== 'quick-tools' || surfaceHost.params.nativeQuickTools === true);
  const contributed = () => sections().find((item) => matches(item, props.route()));
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
    const fallback = sections().find((item) => matches(item, props.defaultRoute)) ?? sections()[0];
    props.route.set(fallback ? { instance: fallback.instance.instance, id: fallback.id } : null);
  });
  // The page may hold the exit behind a prompt, so the request is checked again when it runs.
  const leave = (next: () => void) => {
    const current = page();
    if (current?.leave) current.leave(next);
    else next();
  };
  const choose = (request: { from: string | null; to: string }) => {
    const valid = () =>
      alive &&
      !busy() &&
      (contributed()?.key ?? null) === request.from &&
      request.from !== request.to;
    if (!valid()) return;
    leave(() => {
      const target = sections().find((item) => item.key === request.to);
      if (!valid() || !target) return;
      if (!operations.pending().length) {
        operations.error.set('');
        operations.notice.set('');
      }
      props.route.set({ instance: target.instance.instance, id: target.id });
    });
  };
  const closeNow = () => {
    if (alive && !busy()) props.input.close();
  };
  const close = () => {
    if (alive && !busy()) leave(closeNow);
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
    if (page()?.back() ?? true) close();
  };
  const cancel = (request: BackAction) => () => back(request);
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
  const action = () => page()?.action?.() ?? null;
  const terminal = platform.idiom === 'terminal';
  const iconButton = {
    ...controlStyle,
    width: 32,
    paddingHorizontal: 8,
    alignItems: 'center',
  } as const;
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
          flex: 1,
          maxHeight: 800,
          minHeight: 0,
          flexDirection: rail() ? 'row' : 'column',
          backgroundColor: C.surface,
          borderRadius: compact() ? 12 : 24,
          borderWidth: 1,
          borderColor: C.line,
          // The border takes a whole terminal row but only one point of layout:
          // the rest of that row keeps the title off it and rows on whole cells.
          paddingTop: terminal ? 15 : 0,
        }}
      >
        <View
          style={{
            flexDirection: rail() ? 'column' : 'row',
            flexWrap: rail() ? 'nowrap' : 'wrap',
            width: rail() ? 200 : '100%',
            flexShrink: 0,
            paddingHorizontal: rail() ? 12 : 8,
            paddingTop: rail() ? (terminal ? 0 : 20) : 8,
            paddingBottom: rail() ? 16 : 0,
            gap: 2,
          }}
        >
          <If when={rail()}>
            <Text
              style={{
                ...captionTextStyle,
                fontWeight: '600',
                color: C.muted,
                paddingHorizontal: 12,
                paddingTop: 2,
                paddingBottom: 12,
              }}
            >
              {tr('Settings')}
            </Text>
          </If>
          <Each of={sections()} key={(item) => item.key}>
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
                style={{ ...controlStyle, paddingVertical: 6 }}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text
                  style={{
                    ...captionTextStyle,
                    lineHeight: terminal ? 16 : 20,
                    fontWeight: contributed()?.key === item().key ? '500' : undefined,
                    color: contributed()?.key === item().key ? C.text : C.secondary,
                  }}
                >
                  {contributionTitle(item())}
                </Text>
              </Button>
            )}
          </Each>
        </View>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            margin: terminal ? 0 : 8,
            marginLeft: terminal || rail() ? 0 : 8,
            backgroundColor: terminal ? undefined : C.background,
            borderRadius: terminal ? 0 : 16,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              minHeight: terminal ? 16 : compact() ? 48 : 64,
              paddingLeft: settingsGutter + settingsInset,
              paddingRight: terminal ? 0 : 12,
            }}
          >
            <If when={page()?.nested() ?? false}>
              <Button
                disabled={busy()}
                accessibilityLabel={page()?.backLabel?.() ?? tr('Back')}
                tooltip={textTooltip(() => tr('Back'))}
                onPress={inputAction(back, backAction())}
                style={{ ...iconButton, marginLeft: terminal ? 0 : -8 }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Icon name="back" color={C.secondary} />
              </Button>
            </If>
            <Text
              style={[
                {
                  flex: 1,
                  minWidth: 0,
                  color: C.text,
                  fontWeight: '600',
                  fontSize: 18,
                  lineHeight: 24,
                },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {title()}
            </Text>
            <If when={action()}>
              <SettingsButton
                label={action()!.label}
                disabled={busy() || action()!.disabled}
                onPress={() => action()?.run()}
              />
            </If>
            <Button
              disabled={busy()}
              accessibilityLabel={tr('Close settings')}
              tooltip={textTooltip(() => tr('Close settings'))}
              onPress={inputAction(close, null)}
              style={iconButton}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="close" color={C.secondary} />
            </Button>
          </View>
          <If when={operations.error() || operations.notice() || operations.pending().length > 0}>
            <View
              style={{
                paddingLeft: settingsGutter + settingsInset,
                paddingRight: settingsGutter,
                paddingBottom: terminal ? 0 : 12,
              }}
            >
              <If when={operations.error()}>
                <Text style={[{ ...captionTextStyle, color: C.danger }, { userSelect: 'text' }]}>
                  {operations.error()}
                </Text>
              </If>
              <If when={!operations.error() && operations.notice()}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>{operations.notice()}</Text>
              </If>
              <If when={operations.pending().length > 0}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {tr('Checking action status…')}
                </Text>
              </If>
            </View>
          </If>
          <View style={{ flex: 1, minHeight: 0 }}>
            <Each of={contributed() ? [contributed()!] : []} key={(item) => item.key}>
              {(item) => runtime.render(item(), { sessionId: null, input: input(item()) })}
            </Each>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
