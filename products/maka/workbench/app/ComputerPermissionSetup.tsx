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
  nativeComponent,
  cleanup,
  effect,
  inputAction,
  keymap,
  signal,
  Scroll,
  Text,
  View,
  type ViewRef,
} from 'nsh';
import type { SystemPermissionGrant } from '../../../../packages/plugin-sdk/src/generated/runtime';
import {
  createComputerPermissionSetup,
  nextPermission,
  type ComputerPermissionClient,
  type PermissionSetupState,
  type SystemPermissionRequest,
  type ComputerPermissionStatus,
} from './computerPermissionSetupState';
import { PermissionButton, PermissionRow } from './ComputerPermissionControls';
import { Icon } from './Icon';
import { controlsLeft, controlsRight, TITLE_BAR_HEIGHT } from './chrome';
import { LoadingState } from './Loading';
import { tr } from './locale';
import { errorText, renderText } from './text';
import { bodyTextStyle, captionTextStyle, C, Disclosure } from './ui';

// The native factory owns the trusted application URL; no path crosses from the UI.
const PermissionApplication = nativeComponent<
  {},
  {
    dragError: { message: string };
    dragStart: null;
  }
>('maka.permissionApplication', {
  props: [],
  events: ['dragError', 'dragStart'],
});
export const systemPermissionName = (grant: SystemPermissionGrant) =>
  grant === 'accessibility' ? tr('Accessibility') : tr('Screen & System Audio Recording');

/** The same task surface is hosted in a desktop utility window or inline on terminal/non-window clients. */
export function ComputerPermissionSetup(props: {
  client: ComputerPermissionClient;
  request: SystemPermissionRequest;
  presentation: 'window' | 'inline';
  nativeApplicationDrag?: boolean;
  onClose?: () => Promise<void> | void;
  onOutcome?: (outcome: NonNullable<ComputerPermissionStatus['outcome']>) => void;
}) {
  const model = signal<PermissionSetupState>({
    status: null,
    actions: [],
    operation: 'loading',
    active: null,
    attempted: [],
    error: null,
  });
  const help = signal(false);
  const closeError = signal<unknown | null>(null);
  const dragFailed = signal(false);
  let alive = true;
  let primary: ViewRef | undefined;
  let done: ViewRef | undefined;
  let lastFocus: string | null = null;
  const controller = createComputerPermissionSetup(props.client, (state) => {
    model.set(state);
    if (state.status?.outcome) props.onOutcome?.(state.status.outcome);
  });
  cleanup(() => {
    alive = false;
    controller.dispose();
  });
  effect(() => {
    void Promise.resolve().then(() => controller.refresh());
  });
  const status = () => model().status;
  const request = () => props.request;
  const settled = () => !!status()?.outcome;
  const granted = () => status()?.outcome?.kind === 'system_permission_granted';
  const grants = () => request().grants;
  const ready = (grant: SystemPermissionGrant) =>
    status()?.grants.some((entry) => entry.grant === grant && entry.effective) ?? false;
  const next = () => nextPermission(status());
  const busy = () => model().operation !== 'idle';
  const showApplicationDrag = () => {
    const active = model().active;
    return (
      props.nativeApplicationDrag === true &&
      status()?.requestable === true &&
      !settled() &&
      active !== null &&
      model().attempted.includes(active) &&
      !ready(active)
    );
  };
  const dragInstruction = () =>
    tr('permissionSetup.drag', {
      permission: systemPermissionName(model().active!),
    });
  const close = async () => {
    closeError.set(null);
    try {
      await props.onClose?.();
    } catch (error) {
      if (alive) closeError.set(error);
    }
  };
  // This dedicated surface owns Escape even when a disabled primary releases focus.
  // NSH's keymap is local to its window, not an OS-wide shortcut.
  if (props.presentation === 'window')
    keymap.bind('escape', () => void close(), { when: 'always' });
  effect(() => {
    // Focus once per real step, not on each poll. Return activates the focused semantic Button.
    const target = settled() ? 'done' : status()?.requestable ? next() : null;
    if (target && target !== lastFocus && !busy()) {
      lastFocus = target;
      if (target === 'done') done?.focus();
      else primary?.focus();
    }
  });
  const content = (
    <View class="gap-6">
      <View class="gap-2">
        <Text role="header" class="text-xl font-semibold" style={{ color: C.text }}>
          {settled()
            ? granted()
              ? tr('permissionSetup.complete')
              : tr('permissionSetup.closed')
            : tr('permissionSetup.title')}
        </Text>
        <If when={status()}>
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>
            {settled()
              ? granted()
                ? tr('permissionSetup.resumed')
                : tr('permissionSetup.closedBody')
              : tr('permissionSetup.subtitle', {
                  application: request().application,
                })}
          </Text>
        </If>
      </View>
      <If when={!status()}>
        <LoadingState label={tr('permissionSetup.loading')} />
      </If>
      <If when={status()}>
        <View class="gap-1">
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('permissionSetup.application')}
          </Text>
          <Text
            style={{
              ...bodyTextStyle,
              fontWeight: '600',
              color: C.text,
              userSelect: 'text',
            }}
          >
            {request().application}
          </Text>
        </View>
        <View>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('permissionSetup.progress', {
              ready: grants().filter(ready).length,
              total: grants().length,
            })}
          </Text>
          <Each of={grants()} key={(grant) => grant}>
            {(grant, index) => (
              <PermissionRow
                name={systemPermissionName(grant())}
                purpose={
                  grant() === 'accessibility'
                    ? tr('permissionSetup.accessibilityPurpose')
                    : tr('permissionSetup.screenPurpose')
                }
                index={index()}
                ready={ready(grant())}
                active={next() === grant()}
                busy={
                  !settled() &&
                  model().active === grant() &&
                  ['requesting', 'opening'].includes(model().operation)
                }
              />
            )}
          </Each>
        </View>
        <If when={!settled()}>
          <View class="gap-3">
            <If when={status()?.requestable === false}>
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                {tr('permissionSetup.unavailable')}
              </Text>
            </If>
            <If when={model().active && next()}>
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                {tr('permissionSetup.turnOn', {
                  application: request().application,
                })}
              </Text>
            </If>
            <If when={!next()}>
              <View class="flex-row items-center gap-2">
                <Icon name="check" color={C.success} />
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                  {tr('permissionSetup.verifying')}
                </Text>
              </View>
            </If>
          </View>
          <If when={status()?.requestable && model().active}>
            <View class="gap-3">
              <Disclosure
                label={tr('permissionSetup.help')}
                open={help()}
                onPress={() => help.set(!help())}
              >
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                  {tr('permissionSetup.help')}
                </Text>
              </Disclosure>
              <If when={help()}>
                <If
                  when={
                    !props.nativeApplicationDrag && model().actions.includes('reveal_application')
                  }
                >
                  <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                    {tr('permissionSetup.helpBody')}
                  </Text>
                  <PermissionButton
                    label={tr('permissionSetup.finder')}
                    disabled={busy()}
                    onPress={() => void controller.open('reveal_application')}
                  />
                </If>
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                  {tr('permissionSetup.restartHint')}
                </Text>
              </If>
            </View>
          </If>
        </If>
      </If>
      <If when={model().error || closeError()}>
        <View class="gap-2">
          <Text role="alert" style={{ ...bodyTextStyle, color: C.danger }}>
            {renderText(errorText(closeError() ?? model().error))}
          </Text>
          <If when={!status()}>
            <PermissionButton
              label={tr('Retry')}
              disabled={busy()}
              onPress={() => void controller.refresh()}
            />
          </If>
        </View>
      </If>
    </View>
  );
  return (
    <View
      class={props.presentation === 'window' ? 'flex-1 min-h-0' : 'gap-4'}
      style={{ backgroundColor: C.background }}
    >
      <If when={props.presentation === 'window'}>
        <View
          desktop={{ windowDrag: true }}
          style={{
            height: TITLE_BAR_HEIGHT,
            flexShrink: 0,
            justifyContent: 'center',
            paddingLeft: 16 + controlsLeft(true),
            paddingRight: 16 + controlsRight(true),
            backgroundColor: C.surface,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
          }}
        >
          <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>
            {tr('permissionSetup.title')}
          </Text>
        </View>
      </If>
      {props.presentation === 'window' ? (
        <Scroll class="flex-1 min-h-0" contentClass="p-6">
          {content}
        </Scroll>
      ) : (
        content
      )}
      <View
        class={props.presentation === 'window' ? 'gap-3 p-4' : 'gap-3 pt-4'}
        style={{ flexShrink: 0, borderTopWidth: 1, borderTopColor: C.line }}
      >
        <If when={showApplicationDrag()}>
          <View class="gap-2">
            <PermissionApplication
              class="h-20"
              accessibilityLabel={dragInstruction()}
              onDragStart={() => dragFailed.set(false)}
              onDragError={({ message }) => {
                console.warn('Permission application drag failed:', message);
                dragFailed.set(true);
              }}
            />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{dragInstruction()}</Text>
            <If when={dragFailed()}>
              <Text role="alert" style={{ ...captionTextStyle, color: C.danger }}>
                {tr('permissionSetup.dragFailed')}
              </Text>
            </If>
          </View>
        </If>
        <If when={!settled() && status()?.requestable && next()}>
          <PermissionButton
            buttonRef={(node) => {
              primary = node;
            }}
            label={tr(
              model().attempted.includes(next()!)
                ? 'permissionSetup.openSettings'
                : 'permissionSetup.enable',
              { permission: systemPermissionName(next()!) },
            )}
            primary
            disabled={
              busy() || (model().attempted.includes(next()!) && !model().actions.includes(next()!))
            }
            onPress={inputAction(
              (grant: SystemPermissionGrant) => void controller.enable(grant),
              next()!,
            )}
          />
        </If>

        <If when={!settled() && props.presentation === 'window'}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('permissionSetup.closeHint')}
          </Text>
        </If>
        <View class="flex-row flex-wrap items-center justify-end gap-2">
          <If when={!settled()}>
            <PermissionButton
              label={
                model().operation === 'cancelling'
                  ? tr('permissionSetup.cancelling')
                  : tr('permissionSetup.cancel')
              }
              disabled={model().operation === 'cancelling'}
              onPress={() => void controller.cancel()}
            />
          </If>
          <If when={props.onClose}>
            <PermissionButton
              buttonRef={(node) => {
                done = node;
              }}
              label={settled() ? tr('permissionSetup.done') : tr('permissionSetup.close')}
              primary={settled()}
              onPress={() => void close()}
            />
          </If>
        </View>
      </View>
    </View>
  );
}
