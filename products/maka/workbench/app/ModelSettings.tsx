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
  keymap,
  platform,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  windowSize,
  type Signal,
  type JSX,
} from 'nsh';
import { Button, TitleBar } from 'nsh/base';
import type {
  UiContext,
  UiContributionRef,
  UiHost,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolsSettings,
  quickToolView,
  type SettingsPageInput,
  type SettingsPageNavigation,
  type SettingsRoute,
  type SettingsViewInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { sameValue } from '../../../../plugins/shared/value';
import type { SettingsOperations } from './settingsOperations';
import { contributionTitle } from './plugins/context';
import { Icon } from './Icon';
import { tr } from './locale';
import { controlsRight, ownTitleBar, PANEL_INSET, TITLE_BAR_HEIGHT, windowDrag } from './chrome';
import { InlineCallout } from './Feedback';
import { hasOpenModalSurface } from './ModalDialog';
import { toast } from './toastStore';
import { SettingsButton, settingsGutter, settingsInset } from './SettingsPage';
import {
  C,
  compact,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlDisabledStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

type Registration = { key: string; value: SettingsPageNavigation };
type BackAction = { key: string | null; navigation: string | null };
const matches = (item: UiContributionRef, route: SettingsRoute | null) =>
  route !== null && item.id === route.id && sameValue(item.instance.instance, route.instance);

// Page navigation is registered by the rendered contribution. The shell owns
// Escape navigation and the original journal; pages own their forms and unsaved drafts.
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
  // A quick tool's own page sits under Quick tools, beside its commands, as in the launcher; Quick
  // tools comes last, after Maka's own pages.
  const quickTool = (item: UiContributionRef) =>
    runtime
      .contributions()
      .some(
        (tool) =>
          tool.declaration.kind === 'view' &&
          tool.declaration.contract === quickToolView.id &&
          sameValue(tool.instance.instance, item.instance.instance),
      );
  const pages = computed(() => {
    const shown = runtime.settings().filter((item) => !quickTool(item));
    return [
      ...shown.filter((item) => item.id !== quickToolsSettings),
      ...shown.filter((item) => item.id === quickToolsSettings),
    ];
  });
  const contributed = computed(() => pages().find((item) => matches(item, props.route())));
  const page = () => {
    const registered = navigation();
    return registered && registered.key === contributed()?.key ? registered.value : null;
  };
  const busy = () => operations.navigationBusy() || (page()?.busy?.() ?? false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  effect(() => {
    if (!runtime.ready() || contributed()) return;
    const fallback = pages().find((item) => matches(item, props.defaultRoute)) ?? pages()[0];
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
      const target = pages().find((item) => item.key === request.to);
      if (!valid() || !target) return;
      if (!operations.pending().length) {
        operations.error.set('');
        operations.notice.set('');
      }
      props.route.set({ instance: target.instance.instance, id: target.id });
    });
  };
  let seenNavigation = props.input.navigation?.() ?? 0;
  effect(() => {
    const next = props.input.navigation?.() ?? 0;
    if (next === seenNavigation) return;
    seenNavigation = next;
    untracked(() => {
      const requestedPage = props.input.page;
      if (!requestedPage || !alive || busy()) return;
      const targetRoute =
        requestedPage === 'external-agents'
          ? props.defaultRoute
          : { instance: props.context.instance, id: requestedPage };
      const target =
        pages().find((item) => matches(item, targetRoute)) ??
        pages().find((item) => item.id === requestedPage);
      if (!target) return;
      const from = contributed()?.key ?? null;
      if (from === target.key) {
        const current = page();
        if (current?.nested() && current.returnToRoot) {
          leave(() => {
            if (!alive || busy() || (contributed()?.key ?? null) !== target.key) return;
            current.returnToRoot?.();
          });
        }
        return;
      }
      choose({ from, to: target.key });
    });
  });
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
  const terminal = platform.idiom === 'terminal';
  // Overlays (Select, Popover, Menu) take Escape ahead of JS keymaps in NSH;
  // unbind while any main-window modal dialog is open so it owns Escape, and let
  // desktop inputs blur on first Escape before navigating back.
  effect(() => {
    if (!props.input.opened() || hasOpenModalSurface()) return;
    cleanup(
      keymap.bind('escape', () => back(backAction()), {
        when: terminal ? 'always' : 'notEditing',
      }),
    );
  });
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
  const SETTINGS_NOTICE_TOAST_ID = 'settings.notice';
  let lastNotice = '';
  effect(() => {
    const message = operations.notice();
    if (!message) {
      if (lastNotice) {
        lastNotice = '';
        toast.dismiss(SETTINGS_NOTICE_TOAST_ID);
      }
      return;
    }
    if (message === lastNotice) return;
    lastNotice = message;
    toast.show({ id: SETTINGS_NOTICE_TOAST_ID, tone: 'info', message });
  });
  cleanup(() => {
    if (lastNotice) toast.dismiss(SETTINGS_NOTICE_TOAST_ID);
    if (!operations.pending().length) operations.notice.set('');
  });
  const iconButton = {
    ...controlStyle,
    width: 32,
    ...(terminal ? { minHeight: 16, paddingVertical: 0, borderRadius: 0 } : {}),
    paddingHorizontal: 8,
    alignItems: 'center',
  } as const;
  const backToApp = (fullWidth: boolean) => (
    <Button
      accessibilityLabel={tr('Back to app')}
      disabled={busy()}
      onPress={inputAction(close, null)}
      style={{
        ...controlStyle,
        ...(terminal
          ? { minHeight: 16, paddingHorizontal: 8, paddingVertical: 0, borderRadius: 0 }
          : { paddingHorizontal: 8, paddingVertical: 6 }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 8,
        ...(fullWidth ? { width: '100%' } : { flexShrink: 0 }),
      }}
      hoverStyle={controlHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Icon name="back" color={terminal ? C.secondary : C.muted} />
      <Text
        style={[
          {
            ...captionTextStyle,
            lineHeight: terminal ? 16 : 20,
            color: C.secondary,
            ...(fullWidth ? { flex: 1, minWidth: 0 } : {}),
          },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {tr('Back to app')}
      </Text>
    </Button>
  );
  const sectionButtons = () => (
    <Each of={pages()} key={(item) => item.key}>
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
          style={{
            ...controlStyle,
            ...(terminal
              ? { minHeight: 16, paddingHorizontal: 8, paddingVertical: 0, borderRadius: 0 }
              : { paddingHorizontal: rail() ? 8 : 12, paddingVertical: 6 }),
          }}
          selectedStyle={{ backgroundColor: C.raised }}
          hoverStyle={controlHoverStyle()}
          activeStyle={quietActiveStyle()}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text
            style={[
              {
                ...captionTextStyle,
                lineHeight: terminal ? 16 : 20,
                fontWeight: contributed()?.key === item().key ? '500' : undefined,
                color: contributed()?.key === item().key ? C.text : C.secondary,
              },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {contributionTitle(item())}
          </Text>
        </Button>
      )}
    </Each>
  );
  const narrowBackBar = () => {
    if (ownTitleBar) {
      return (
        <TitleBar style={{ height: TITLE_BAR_HEIGHT }}>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 8,
            }}
          >
            {backToApp(false)}
          </View>
        </TitleBar>
      );
    }
    if (terminal) return null;
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          paddingTop: 8,
        }}
      >
        {backToApp(false)}
      </View>
    );
  };
  const headerPaddingRight = () =>
    terminal
      ? 0
      : rail()
        ? Math.max(settingsGutter, controlsRight(true) - PANEL_INSET)
        : settingsGutter;
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        flexDirection: rail() ? 'row' : 'column',
        backgroundColor: terminal ? C.background : C.chrome,
      }}
    >
      <If
        when={rail()}
        else={
          <View
            style={{
              flexShrink: 0,
              backgroundColor: terminal ? C.background : C.chrome,
              ...(terminal ? { borderBottomWidth: 1, borderBottomColor: C.line } : {}),
            }}
          >
            {narrowBackBar()}
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                paddingHorizontal: 8,
                paddingTop: terminal ? 0 : ownTitleBar ? 0 : 4,
                paddingBottom: terminal ? 0 : 8,
                gap: terminal ? 8 : 2,
              }}
            >
              {terminal ? backToApp(false) : null}
              {sectionButtons()}
            </View>
          </View>
        }
      >
        <View
          style={{
            width: 224,
            flexShrink: 0,
            backgroundColor: terminal ? C.background : C.chrome,
            paddingTop: terminal ? 0 : ownTitleBar ? 0 : 12,
            gap: terminal ? 0 : 8,
            ...(terminal ? { borderRightWidth: 1, borderRightColor: C.line } : {}),
          }}
        >
          {ownTitleBar ? (
            <TitleBar style={{ height: TITLE_BAR_HEIGHT }}>
              <View />
            </TitleBar>
          ) : null}
          <View
            style={{
              paddingHorizontal: terminal ? 8 : 12,
              ...(terminal ? { paddingBottom: 16 } : {}),
            }}
          >
            {backToApp(true)}
          </View>
          <Scroll
            style={{ flex: 1, minHeight: 0 }}
            contentStyle={{
              paddingHorizontal: terminal ? 8 : 12,
              paddingBottom: terminal ? 16 : 12,
              gap: terminal ? 0 : 2,
            }}
          >
            {sectionButtons()}
          </Scroll>
        </View>
      </If>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          margin: terminal ? 0 : PANEL_INSET,
          marginLeft: terminal || rail() ? 0 : PANEL_INSET,
          marginTop: terminal ? 0 : rail() ? PANEL_INSET : 0,
          ...(terminal && rail() ? { paddingLeft: 16 } : {}),
          backgroundColor: terminal ? undefined : C.panel,
          borderRadius: terminal ? 0 : 12,
          overflow: 'hidden',
        }}
      >
        <View
          desktop={rail() ? windowDrag : undefined}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: terminal ? 16 : rail() ? 56 : 48,
            paddingLeft: settingsGutter + settingsInset,
            paddingRight: headerPaddingRight(),
          }}
        >
          <If when={page()?.nested() ?? false}>
            <Button
              disabled={busy()}
              accessibilityLabel={page()?.backLabel?.() ?? tr('Back')}
              tooltip={textTooltip(() => tr('Back'))}
              onPress={inputAction(back, backAction())}
              style={{
                ...iconButton,
                marginLeft: terminal ? 0 : -8,
              }}
              hoverStyle={quietHoverStyle()}
              activeStyle={quietActiveStyle()}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="back" color={C.secondary} />
            </Button>
          </If>
          <Text
            role="header"
            style={[
              {
                flex: 1,
                minWidth: 0,
                color: C.text,
                fontWeight: '600',
                fontSize: 18,
                lineHeight: terminal ? 16 : 24,
              },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {title()}
          </Text>
          <If when={action()}>
            <SettingsButton
              label={action()!.label}
              disabled={operations.busy() || busy() || action()!.disabled}
              onPress={() => action()?.run()}
            />
          </If>
        </View>
        <If
          when={
            (!page()?.ownsError?.() && Boolean(operations.error())) ||
            operations.pending().length > 0
          }
        >
          <View
            style={{
              paddingLeft: settingsGutter + settingsInset,
              paddingRight: settingsGutter,
              paddingBottom: terminal ? 0 : 8,
            }}
          >
            <InlineCallout
              tone={!page()?.ownsError?.() && operations.error() ? 'danger' : 'info'}
              message={
                (!page()?.ownsError?.() && operations.error()) ||
                tr('Checking whether settings changes were applied…')
              }
            />
          </View>
        </If>
        <View style={{ flex: 1, minHeight: 0 }}>
          <Each of={contributed() ? [contributed()!] : []} key={(item) => item.key}>
            {(item) => runtime.render(item(), { sessionId: null, input: input(item()) })}
          </Each>
        </View>
      </View>
    </View>
  );
}
