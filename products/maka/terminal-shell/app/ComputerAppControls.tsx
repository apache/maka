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

import { cleanup, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { AgentComputerApps } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { Control } from './Conversation';
import { computerAppRiskMessage } from './interaction-computer-app';
import { tr } from './locale';
import { errorText, renderText, type UiText } from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
} from './ui';

export function ComputerAppControls(props: {
  sessionId: string;
  apps(): AgentComputerApps;
  control: Control;
}) {
  let alive = true;
  const failure = signal<{ operationId: string; message: UiText } | null>(null);
  cleanup(() => {
    alive = false;
  });
  const current = (operationId: string) =>
    props
      .apps()
      .entries.find((entry) => entry.activity.operationId === operationId && !entry.stopped);
  const stop = async ({ sessionId, operationId }: { sessionId: string; operationId: string }) => {
    if (!alive || sessionId !== props.sessionId || !current(operationId)) return;
    failure.set(null);
    try {
      await props.control('stopComputerApp', { sessionId, operationId });
    } catch (reason) {
      if (alive && current(operationId)) failure.set({ operationId, message: errorText(reason) });
    }
  };
  return (
    <If when={props.apps().entries.length > 0}>
      <View
        style={{ minHeight: 0, flexShrink: 1, gap: 8, padding: 12, backgroundColor: C.surface }}
      >
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Computer access this turn')}
        </Text>
        <Scroll
          accessibilityLabel={tr('Computer application access')}
          style={{ minHeight: 0, maxHeight: 240 }}
        >
          <View style={{ gap: 12 }}>
            <Each of={props.apps().entries} key={(entry) => entry.activity.operationId}>
              {(entry) => (
                <View style={{ gap: 4 }}>
                  <Text selectable style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
                    {entry().activity.display.name}
                  </Text>
                  <Text selectable style={{ ...codeTextStyle, color: C.secondary }}>
                    {entry().activity.display.appPath}
                  </Text>
                  <Text selectable style={{ ...codeTextStyle, color: C.secondary }}>
                    {entry().activity.target.scope.kind === 'computer_app'
                      ? entry().activity.target.scope.applicationId
                      : tr('unavailable')}
                  </Text>
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {renderText(computerAppRiskMessage(entry().activity.display.risk))}
                  </Text>
                  <If when={entry().stopped}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Access stopped for this turn')}
                    </Text>
                  </If>
                  <Button
                    accessibilityLabel={tr('Stop access to {app}', {
                      app: entry().activity.display.name,
                    })}
                    disabled={entry().stopped}
                    onPress={inputAction(stop, {
                      sessionId: props.sessionId,
                      operationId: entry().activity.operationId,
                    })}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ ...bodyTextStyle, color: entry().stopped ? C.muted : C.text }}>
                      {tr('Stop access to {app}', { app: entry().activity.display.name })}
                    </Text>
                  </Button>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <If when={failure() && current(failure()!.operationId)}>
          <Text style={{ ...bodyTextStyle, color: C.danger }}>
            {failure() ? renderText(failure()!.message) : ''}
          </Text>
        </If>
      </View>
    </If>
  );
}
