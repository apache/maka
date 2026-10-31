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
import type { GrantScope } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ComposerComputerAccess } from '../../../../packages/plugin-sdk/src/composer-view.js';
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

const applicationId = (scope: GrantScope) =>
  scope.kind === 'computer_app' ? scope.applicationId : tr('unavailable');

export function createComputerAppControls(access: ComposerComputerAccess, height: () => number) {
  let alive = true;
  const failure = signal<{ operationId: string; message: UiText } | null>(null);
  cleanup(() => {
    alive = false;
  });
  const current = (operationId: string) =>
    access
      .snapshot()
      .entries.find((entry) => entry.activity.operationId === operationId && !entry.stopped);
  const stop = async (operationId: string) => {
    if (!alive || !current(operationId)) return;
    failure.set(null);
    try {
      await access.stop(operationId);
    } catch (reason) {
      if (alive && current(operationId)) failure.set({ operationId, message: errorText(reason) });
    }
  };
  return {
    shown: () => access.snapshot().entries.length > 0,
    summary: () => String(access.snapshot().entries.filter((entry) => !entry.stopped).length),
    preview: () =>
      failure() && current(failure()!.operationId)
        ? renderText(failure()!.message)
        : access
            .snapshot()
            .entries.map((entry) => entry.activity.display.name)
            .join(', '),
    problem: () => !!failure() && !!current(failure()!.operationId),
    content: () => (
      <View style={{ minHeight: 0, flexShrink: 1 }}>
        <Scroll
          accessibilityLabel={tr('Computer application access')}
          style={{ minHeight: 0, maxHeight: height(), flexShrink: 1, flexGrow: 0 }}
          contentStyle={{ padding: 12 }}
        >
          <View style={{ gap: 12 }}>
            <Each of={access.snapshot().entries} key={(entry) => entry.activity.operationId}>
              {(entry) => (
                <View style={{ gap: 4 }}>
                  <Text
                    style={[
                      { ...bodyTextStyle, color: C.text, fontWeight: '600' },
                      { userSelect: 'text' },
                    ]}
                  >
                    {entry().activity.display.name}
                  </Text>
                  <Text style={[{ ...codeTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
                    {entry().activity.display.appPath}
                  </Text>
                  <Text style={[{ ...codeTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
                    {applicationId(entry().activity.target.scope)}
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
                    onPress={inputAction(stop, entry().activity.operationId)}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ ...bodyTextStyle, color: entry().stopped ? C.muted : C.text }}>
                      {tr('Stop access to {app}', { app: entry().activity.display.name })}
                    </Text>
                  </Button>
                </View>
              )}
            </Each>
            <If when={failure() && current(failure()!.operationId)}>
              <Text style={{ ...bodyTextStyle, color: C.danger }}>
                {failure() ? renderText(failure()!.message) : ''}
              </Text>
            </If>
          </View>
        </Scroll>
      </View>
    ),
  };
}
