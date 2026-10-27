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

import { ErrorBoundary, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { UiToolProps } from '../../../../../packages/plugin-sdk/src/workbench.js';
import { tr } from '../locale';
import { errorText, renderText } from '../text';
import { C, bodyTextStyle, captionTextStyle, controlStyle } from '../ui';
import { type Contribution, type Plugins, pluginContext } from './registry';

export function PluginInstances(props: { plugins: Plugins }) {
  return (
    <View style={{ display: 'none' }}>
      <Each of={props.plugins.entries()} key={(entry) => entry.key}>
        {(entry) => (
          <Each
            of={(() => {
              const state = entry().state();
              return state.kind === 'loaded' || state.kind === 'active' ? [state.module] : [];
            })()}
            key={(module) => module}
          >
            {(module) => (
              <ErrorBoundary
                fallback={(reason) => {
                  props.plugins.fail(entry(), reason);
                  return null;
                }}
              >
                <PluginActivation plugins={props.plugins} entry={entry()} module={module()} />
              </ErrorBoundary>
            )}
          </Each>
        )}
      </Each>
    </View>
  );
}

function PluginActivation(props: {
  plugins: Plugins;
  entry: import('./registry').PluginEntry;
  module: import('../../../../../packages/plugin-sdk/src/workbench.js').UiModule<
    import('nsh').JSX.Element
  >;
}) {
  props.plugins.activate(props.entry, props.module);
  return null;
}

type ToolInput = Omit<UiToolProps, 'context'>;
type ViewProps = {
  contribution: Contribution;
  sessionId(): string | null;
  input?: () => unknown;
  tool?: () => ToolInput;
};

function PluginError(props: { reason: unknown; retry(): void }) {
  return (
    <View style={{ gap: 8, padding: 8 }}>
      <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
        {renderText(errorText(props.reason))}
      </Text>
      <Button
        accessibilityLabel={tr('Retry')}
        onPress={props.retry}
        style={{ ...controlStyle, alignSelf: 'flex-start' }}
      >
        <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
      </Button>
    </View>
  );
}

export function PluginView(props: ViewProps) {
  const plugins = pluginContext()!;
  const contribution = props.contribution;
  const entry = contribution.entry;
  const load = () => void plugins.load(entry).catch((reason) => plugins.fail(entry, reason));
  void Promise.resolve().then(load);
  const retry = () => {
    plugins.retry(entry);
    load();
  };
  return (
    <ErrorBoundary fallback={(reason, reset) => <PluginError reason={reason} retry={reset} />}>
      <If when={entry.state().kind === 'failed'}>
        <PluginError
          reason={(() => {
            const state = entry.state();
            return state.kind === 'failed' ? state.reason : '';
          })()}
          retry={retry}
        />
      </If>
      <If
        when={
          entry.state().kind === 'idle' ||
          entry.state().kind === 'loading' ||
          entry.state().kind === 'loaded'
        }
      >
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading…')}</Text>
      </If>
      <Each
        of={(() => {
          const state = entry.state();
          return state.kind === 'active' ? [state.exports[contribution.id]] : [];
        })()}
        key={(implementation) => implementation}
      >
        {(value) => {
          const implementation = value();
          const context = plugins.contextFor(entry);
          if (implementation.kind === 'tool_renderer') {
            const tool = props.tool!;
            return implementation.render({
              context,
              get field() {
                return tool().field;
              },
              get value() {
                return tool().value;
              },
              get sessionId() {
                return tool().sessionId;
              },
              get through() {
                return tool().through;
              },
              get tool() {
                return tool().tool;
              },
              userScroll: () => tool().userScroll(),
            });
          }
          if (implementation.kind === 'command') return null;
          return implementation.render({
            context,
            get sessionId() {
              return props.sessionId();
            },
            get input() {
              return props.input?.();
            },
          });
        }}
      </Each>
    </ErrorBoundary>
  );
}
