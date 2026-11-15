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

import { tr } from './locale';
import { computed, inputAction, List, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';
import { terminalRunning, terminalStatus, type TerminalsModel } from './terminalState';
import { Icon } from './Icon';
import { SettingsButton } from './SettingsPage';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  textTooltip,
} from './ui';

type TerminalRow = ReturnType<TerminalsModel['entries']>[number];

export function PersonalTerminals(props: {
  model: TerminalsModel;
  entries: readonly TerminalRow[];
  selected?: string;
  cwd?: string;
  open(entry: ResourceUpdate): void;
}) {
  const model = props.model;
  const hasShell = () => props.entries.length > 0;
  return (
    <View style={{ gap: 8, flexShrink: 0 }}>
      <If
        when={hasShell()}
        else={
          <View style={{ gap: 8, paddingVertical: 16, alignItems: 'center' }}>
            <Icon name="terminal" size={20} color={C.muted} />
            <If when={props.cwd}>
              <Directory path={props.cwd!} />
            </If>
            <StartTerminal model={model} iconOnly={false} />
          </View>
        }
      >
        <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          <Scroll horizontal focusable={false} style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <Each of={props.entries} key={(row) => row.value().result.ref}>
                {(row, index) => (
                  <Button
                    selected={props.selected === row().value().result.ref}
                    onPress={inputAction(props.open, row().value())}
                    style={{ ...controlStyle, flexDirection: 'row', gap: 6, alignItems: 'center' }}
                    selectedStyle={{ backgroundColor: C.cardRaised }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon name="terminal" size={14} color={C.muted} />
                    <Text style={{ ...captionTextStyle, color: C.text }}>
                      {tr('Shell {number}', { number: String(index() + 1) })}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </Scroll>
          <StartTerminal model={model} iconOnly />
        </View>
      </If>
      <If when={model.error() || (model.known() && model.pending().length > 0)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text
            style={[
              { ...captionTextStyle, flex: 1, color: model.error() ? C.danger : C.muted },
              { userSelect: 'text' },
            ]}
          >
            {model.error() || tr('Checking terminal command status…')}
          </Text>
          <If when={model.error()}>
            <RefreshTerminals model={model} />
          </If>
        </View>
      </If>
    </View>
  );
}

function Directory(props: { path: string }) {
  return (
    <Text
      tooltip={textTooltip(() => props.path)}
      style={[
        { ...codeTextStyle, maxWidth: '100%', color: C.muted },
        { numberOfLines: 1, textOverflow: 'ellipsis' },
      ]}
    >
      {props.path}
    </Text>
  );
}

function StartTerminal(props: { model: TerminalsModel; iconOnly: boolean }) {
  const model = props.model;
  return (
    <SettingsButton
      onPress={inputAction(model.start, null)}
      disabled={model.starting() || !model.known() || !!model.pending().length}
      accessibilityLabel={tr('New terminal')}
      label={model.starting() ? tr('Starting shell…') : tr('New terminal')}
      tone={props.iconOnly ? 'quiet' : 'primary'}
      icon="plus"
      iconOnly={props.iconOnly}
    />
  );
}

function RefreshTerminals(props: { model: TerminalsModel }) {
  return (
    <Button
      onPress={inputAction(props.model.refresh, null)}
      accessibilityLabel={tr('Refresh terminals')}
      tooltip={textTooltip(() => tr('Refresh terminals'))}
      style={controlStyle}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <Icon name="refresh" color={C.secondary} />
    </Button>
  );
}

export function AgentTerminals(props: {
  model: TerminalsModel;
  running: readonly TerminalRow[];
  finished: readonly TerminalRow[];
  open(entry: ResourceUpdate): void;
}) {
  const expanded = signal(false);
  type Item = { kind: 'finished' } | { kind: 'entry'; row: TerminalRow };
  const items = computed<Item[]>(() => [
    ...props.running.map((row) => ({ kind: 'entry' as const, row })),
    ...(props.finished.length > 0 ? [{ kind: 'finished' as const }] : []),
    ...(expanded() ? props.finished.map((row) => ({ kind: 'entry' as const, row })) : []),
  ]);
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 4 }}>
      <If when={props.model.error()}>
        <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          <Text style={{ ...bodyTextStyle, flex: 1, color: C.danger }}>{props.model.error()}</Text>
          <RefreshTerminals model={props.model} />
        </View>
      </If>
      <If when={items().length === 0 && !props.model.error()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {props.model.loading() ? tr('Reading terminals…') : tr('No commands')}
        </Text>
      </If>
      <List
        each={items()}
        keyExtractor={(item) => (item.kind === 'entry' ? item.row.value().result.ref : item.kind)}
        estimatedItemSize={48}
        accessibilityLabel={tr('Agent terminals')}
        style={{ flex: 1, minHeight: 0 }}
      >
        {(item) => {
          const current = item();
          if (current.kind === 'finished')
            return (
              <Button
                accessibilityLabel={tr('Finished commands')}
                onPress={() => expanded.set(!expanded())}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name={expanded() ? 'down' : 'right'} size={14} color={C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Finished commands')}
                </Text>
              </Button>
            );
          return <AgentTerminalRow entry={current.row.value()} open={props.open} />;
        }}
      </List>
    </View>
  );
}

function AgentTerminalRow(props: { entry: ResourceUpdate; open(entry: ResourceUpdate): void }) {
  const result = () => props.entry.result;
  const title = () => result().cmd || tr('Terminal');
  return (
    <Button
      onPress={inputAction(props.open, props.entry)}
      accessibilityLabel={tr('Open terminal {name}', { name: title() })}
      tooltip={textTooltip(title)}
      style={{
        ...controlStyle,
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <Icon name="terminal" size={16} color={C.muted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[{ ...codeTextStyle, color: C.text }, { numberOfLines: 1 }]}>{title()}</Text>
        <Text
          style={{ ...captionTextStyle, color: terminalRunning(props.entry) ? C.text : C.muted }}
        >
          {terminalStatus(result().status)}
        </Text>
      </View>
      <Icon name="right" size={14} color={C.muted} />
    </Button>
  );
}
