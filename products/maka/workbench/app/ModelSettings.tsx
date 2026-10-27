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

import { textTooltip } from './ui';
import { cleanup, inputAction, signal, Text, View } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { windowSize } from 'nsh';
import { createSettingsOperations } from './settingsOperations';
import { createModelSettings } from './settings';
import { createGeneralSettings } from './generalSettings.ts';
import { createNetworkSettings } from './networkSettings.ts';
import { ConnectionSettings } from './ConnectionSettings';
import { GeneralSettings } from './GeneralSettings';
import { NetworkSettings } from './NetworkSettings';
import { PluginSettings } from './PluginSettings';
import { createPluginSettings } from './pluginSettings.ts';
import {
  C,
  compact,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';
import { Icon } from './Icon';
import { tr } from './locale';
import type { ModelSelection } from '../../../../packages/plugin-sdk/src/generated/runtime';
import { dialogTop } from './chrome';

type Section = 'general' | 'connections' | 'network' | 'plugins';
type BackAction = { section: Section; identity: string };
const sections = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections & models' },
  { id: 'network', label: 'Network' },
  { id: 'plugins', label: 'Plugins' },
] as const satisfies readonly { id: Section; label: string }[];

// One native Dialog owns focus restoration. Forms keep their own canonical
// snapshot and unsaved edits; all writes share the original native journal.
export function ModelSettings(props: { close(): void; changed(): void; model?: ModelSelection }) {
  const section = signal<Section>('connections');
  const rail = () => windowSize().width >= 880 && !compact();
  const operations = createSettingsOperations();
  const connections = createModelSettings(
    props.changed,
    operations,
    () => section() === 'connections',
    props.model,
  );
  const general = createGeneralSettings(operations, () => section() === 'general');
  const network = createNetworkSettings(operations, () => section() === 'network');
  const plugins = createPluginSettings(operations, () => section() === 'plugins');
  const pages = { connections, general, network, plugins };
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const choose = (request: { from: Section; to: Section }) => {
    if (!alive || operations.busy() || section() !== request.from || request.from === request.to)
      return;
    pages[request.from].deactivate();
    if (!operations.pending().length) {
      operations.error.set('');
      operations.notice.set('');
    }
    section.set(request.to);
    pages[request.to].activate();
  };
  const backAction = (): BackAction => ({
    section: section(),
    identity: pages[section()].navigation(),
  });
  const back = (request: BackAction) => {
    if (
      !alive ||
      operations.busy() ||
      section() !== request.section ||
      pages[request.section].navigation() !== request.identity
    )
      return;
    if (pages[request.section].back()) props.close();
  };
  const close = () => {
    if (alive && !operations.busy()) props.close();
  };
  const cancel = (request: BackAction) => () => back(request);
  const recover = () =>
    operations.recover(async (original, value) => {
      const method = original.method;
      if (original.endpoint === 'agent' && method === 'updateGlobalInstructions')
        await general.recovered(value);
      else if (original.endpoint === 'management') plugins.reset();
      else if (method === 'updateAssistantPreferences') general.reset();
      else if (method === 'updateNetwork') network.reset();
      else {
        connections.reset();
        props.changed();
      }
    });
  const title = () => {
    const current = section();
    return current === 'connections'
      ? {
          connections: tr('Connections & models'),
          providers: tr('Add connection'),
          connection: tr('Connection settings'),
          models: tr('Connection models'),
          model: tr('Model settings'),
        }[connections.page()]
      : pages[current].title();
  };
  const nested = () =>
    section() === 'connections'
      ? connections.page() !== 'connections' || !!connections.confirmation()
      : section() === 'general'
        ? general.editor() !== null
        : section() === 'plugins' && plugins.selected() !== null;
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
        backgroundColor: '#00000099',
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
          <If when={nested()}>
            <Button
              disabled={operations.busy()}
              accessibilityLabel={
                section() === 'connections'
                  ? tr('Back from connection settings')
                  : section() === 'general'
                    ? tr('Back from general settings')
                    : tr('Back from plugins settings')
              }
              tooltip={textTooltip(() => tr('Back'))}
              onPress={inputAction(back, backAction())}
              style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="back" color={C.secondary} />
            </Button>
          </If>
          <Text style={{ flex: 1, color: C.text, fontWeight: '600', fontSize: 18, lineHeight: 24 }}>
            {title()}
          </Text>
          <Button
            disabled={operations.busy()}
            accessibilityLabel={tr('Close settings')}
            tooltip={textTooltip(() => tr('Close settings'))}
            onPress={inputAction(close, null)}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
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
            <Each of={sections} key={(item) => item.id}>
              {(item) => (
                <Button
                  disabled={operations.busy()}
                  selected={section() === item().id}
                  accessibilityLabel={tr('Settings section {section}', {
                    section: tr(item().label),
                  })}
                  onPress={inputAction(choose, { from: section(), to: item().id })}
                  style={{ ...controlStyle, minHeight: rail() ? 40 : 32 }}
                  selectedStyle={{ backgroundColor: C.raised }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: section() === item().id ? C.text : C.muted,
                    }}
                  >
                    {tr(item().label)}
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
            <If when={!operations.pendingKnown() || operations.pending().length > 0}>
              <View
                style={{ gap: 8, padding: 12, backgroundColor: C.background, borderRadius: 12 }}
              >
                <Text style={{ ...bodyTextStyle, color: C.warning }}>
                  {tr('Earlier settings actions must be resolved before another change.')}
                </Text>
                <Button
                  disabled={operations.busy()}
                  accessibilityLabel={tr('Recover settings actions')}
                  onPress={inputAction(recover, null)}
                  style={{ ...controlStyle, alignSelf: 'flex-start' }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.accent }}>
                    {operations.busy()
                      ? tr('Checking receipts…')
                      : tr('Recover original settings actions')}
                  </Text>
                </Button>
                <Each
                  of={operations.pending().filter((item) => !item.reference)}
                  key={(item) => item.id}
                >
                  {(item) => (
                    <Button
                      disabled={operations.busy()}
                      onPress={inputAction(operations.abandon, item().id)}
                      style={{ ...controlStyle, alignSelf: 'flex-start' }}
                      hoverStyle={controlHoverStyle}
                      focusStyle={controlFocusStyle}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Text style={{ ...captionTextStyle, color: C.warning }}>
                        {tr('Abandon unconfirmed {method}', { method: item().method })}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
            </If>
            <If when={section() === 'connections'}>
              <ConnectionSettings owner={connections} />
            </If>
            <If when={section() === 'general'}>
              <GeneralSettings owner={general} />
            </If>
            <If when={section() === 'network'}>
              <NetworkSettings owner={network} />
            </If>
            <If when={section() === 'plugins'}>
              <PluginSettings owner={plugins} />
            </If>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
