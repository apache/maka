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

import { cleanup, Text, View } from 'nsh';
import { currentWindow, isAvailable as desktopAvailable } from 'nsh/desktop';
import {
  SettingsBody,
  SettingsLede,
  SettingsRow,
  SettingsSection,
  SettingsProblem,
  SettingsButton,
} from './SettingsPage';
import { C, captionTextStyle } from './ui';
import { SettingsSkeleton } from './Loading';
import { tr, type MessageKey } from './locale';
import {
  createPermissionSettings,
  names,
  statusLabel,
  type Grant,
  type Subject,
} from './permissionSettingsState';

export function SystemPermissionSettings({
  owner,
}: {
  owner: ReturnType<typeof createPermissionSettings>;
}) {
  if (desktopAvailable) {
    cleanup(
      currentWindow().on('focusChange', ({ focused }) => {
        if (focused) void owner.refresh();
      }),
    );
  }
  const desktop = () => {
    const d = owner.desktop();
    return d?.supported ? d : null;
  };
  const host = () => owner.host()?.status;
  const row = (subject: Subject, grant: Grant, purpose: MessageKey) => {
    const file = grant === 'files' || grant === 'disk';
    const value = () =>
      subject === 'host'
        ? host()?.grants.find((g) => g.grant === grant)?.effective
        : grant === 'files' || grant === 'disk'
          ? undefined
          : desktop()?.[grant];
    const local = () => subject === 'desktop' || !!owner.host()?.local;
    const pendingHost = () =>
      subject === 'host' && host()?.grants.some((g) => g.grant === grant && g.pendingHost);
    const blocked = () => value() === 'denied' || value() === 'restricted';
    const showRestart = () =>
      subject === 'desktop' &&
      owner.restartHint() === grant &&
      value() === false &&
      desktop()?.canRestart;
    const requestable = () => value() === false || value() === 'notDetermined';
    return (
      <SettingsRow
        strongLabel
        label={tr(names[grant])}
        description={tr(purpose)}
        detail={
          <>
            <If when={pendingHost()}>
              <Text style={{ ...captionTextStyle, color: C.warning }}>
                {tr('permissionGuide.pending', { application: host()?.application ?? '' })}
              </Text>
            </If>
            <If when={subject === 'desktop' && owner.restartHint() === grant && value() === false}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('permissionGuide.restartHint')}
              </Text>
            </If>
          </>
        }
        trailing={
          <View class="flex-row items-center gap-1" style={{ flexShrink: 0 }}>
            <View class="items-end justify-center" style={{ minWidth: 56, minHeight: 32 }}>
              <If when={!pendingHost() && !file && (!local() || !requestable())}>
                <Text
                  style={{
                    ...captionTextStyle,
                    fontWeight: '500',
                    lineHeight: 20,
                    color:
                      value() === true || value() === 'granted'
                        ? C.success
                        : blocked()
                          ? C.warning
                          : C.muted,
                  }}
                >
                  {tr(statusLabel(value()))}
                </Text>
              </If>
              <If when={pendingHost()}>
                <SettingsButton
                  label={tr('permissionGuide.recheck')}
                  disabled={owner.busy()}
                  onPress={() => void owner.refresh()}
                />
              </If>
              <If when={local() && !pendingHost()}>
                <If when={showRestart()}>
                  <SettingsButton
                    label={tr('permissionGuide.restart')}
                    disabled={owner.busy()}
                    onPress={() => void owner.act('desktop', 'restart', grant)}
                  />
                </If>
                <If when={!file && requestable() && !showRestart()}>
                  <SettingsButton
                    label={tr('Allow')}
                    accessibilityLabel={tr('Allow') + ' · ' + tr(names[grant])}
                    tone="primary"
                    disabled={owner.busy()}
                    onPress={() => void owner.act(subject, 'request', grant)}
                  />
                </If>
              </If>
            </View>
            <View class="items-end justify-center" style={{ minHeight: 32 }}>
              <If when={local() && !pendingHost()}>
                <SettingsButton
                  label={(file ? tr('permissionSettings.go') : tr('Settings')) + ' ↗'}
                  tone={blocked() ? 'primary' : file ? undefined : 'quiet'}
                  accessibilityLabel={tr('permissionSetup.openSettings', {
                    permission: tr(names[grant]),
                  })}
                  disabled={owner.busy()}
                  onPress={() => void owner.act(subject, 'open', grant)}
                />
              </If>
            </View>
          </View>
        }
      />
    );
  };
  const finder = (subject: Subject) => (
    <SettingsButton
      tone="quiet"
      label={tr('permissionSetup.finder')}
      disabled={owner.busy()}
      onPress={() => void owner.act(subject, 'reveal', 'accessibility')}
    />
  );
  return (
    <SettingsBody>
      <If when={owner.actionError()}>
        <SettingsProblem message={owner.actionError()} />
      </If>
      <If when={owner.desktop()?.supported !== false}>
        <SettingsSection
          titleTag={desktop()?.application}
          title={tr('Desktop features')}
          trailing={<If when={desktop()?.canReveal}>{finder('desktop')}</If>}
        >
          <If when={owner.desktopError()}>
            <SettingsProblem message={owner.desktopError()} retry={owner.refresh} />
          </If>
          <If when={!owner.desktop() && !owner.desktopError()}>
            <SettingsSkeleton rows={3} />
          </If>
          <If when={desktop()}>
            {row('desktop', 'microphone', 'Use for dictation')}
            {row(
              'desktop',
              'accessibility',
              'Allow Accessibility to snap to the controls inside windows.',
            )}
            {row('desktop', 'screen_recording', 'Take a screenshot')}
          </If>
        </SettingsSection>
      </If>
      <SettingsSection
        titleTag={host()?.application}
        title={tr('Agent computer control')}
        description={
          <>
            <If when={owner.host()?.local === false}>
              <SettingsLede>{tr('Connected to a remote device.')}</SettingsLede>
            </If>
            <If when={host()?.supported}>
              <SettingsLede>{tr('permissionSettings.hostInfo')}</SettingsLede>
            </If>
          </>
        }
        trailing={<If when={owner.host()?.local && host()?.bundlePath}>{finder('host')}</If>}
      >
        <If when={owner.hostError()}>
          <SettingsProblem message={owner.hostError()} retry={owner.refresh} />
        </If>
        <If when={!host() && !owner.hostError()}>
          <SettingsSkeleton rows={2} />
        </If>
        <If when={host()?.supported === false}>
          <SettingsProblem message={tr('permissionSettings.unsupported')} />
        </If>
        <If when={host()?.supported}>
          {row('host', 'accessibility', 'permissionSetup.accessibilityPurpose')}
          {row('host', 'screen_recording', 'permissionSetup.screenPurpose')}
        </If>
      </SettingsSection>
      <If when={desktop()}>
        <SettingsSection
          title={tr('File access')}
          description={<SettingsLede>{tr('permissionSettings.filesInfo')}</SettingsLede>}
        >
          {row('desktop', 'files', 'Desktop, Documents and Downloads')}
          {row('desktop', 'disk', 'Access protected data when a task requires it.')}
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}
