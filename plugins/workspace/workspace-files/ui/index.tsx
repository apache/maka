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

import { cleanup, effect, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  UiContext,
  UiExports,
  UiToolProps,
  UiViewProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import { currentLocale, tr } from '../../../../products/maka/workbench/app/locale';
import {
  createCurrentDiff,
  CurrentDiff,
  type CurrentDiffTarget,
} from '../../../../products/maka/workbench/app/CurrentDiff';
import {
  bodyTextStyle,
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
} from '../../../../products/maka/workbench/app/ui';
import { WorkspaceChanges } from './WorkspaceChanges';
import { SearchCapture } from './SearchCapture';

function ChangesPanel(props: UiViewProps) {
  return (
    <If
      when={props.sessionId !== null}
      else={
        <Text style={{ ...bodyTextStyle, color: C.muted }}>
          {tr('Select a conversation to browse its workspace.')}
        </Text>
      }
    >
      <Each of={props.sessionId === null ? [] : [props.sessionId]} key={(id) => id}>
        {(sessionId) => (
          <WorkspaceChanges
            sessionId={sessionId()}
            openDiff={(target) => props.context.openPanel('change-diff', target)}
          />
        )}
      </Each>
    </If>
  );
}

function DiffPanel(props: UiViewProps) {
  const target = () => props.input as CurrentDiffTarget | undefined;
  effect(() => {
    if (target()?.sessionId !== props.sessionId) props.context.openPanel('changes');
  });
  return (
    <If when={target()?.sessionId === props.sessionId}>
      <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
        <Button
          accessibilityLabel={tr('Changes')}
          onPress={() => props.context.openPanel('changes')}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Changes')}</Text>
        </Button>
        <Each
          of={target() === undefined ? [] : [target()!]}
          key={(value) => `${value.sessionId}/${value.area}/${value.path.bytesBase64}`}
        >
          {(value) => {
            const model = createCurrentDiff(value());
            cleanup(() => model.dispose());
            return <CurrentDiff model={model} />;
          }}
        </Each>
      </View>
    </If>
  );
}

export function activate(context: UiContext): UiExports {
  effect(() => currentLocale.set(context.locale()));
  return {
    changes: { kind: 'panel', render: ChangesPanel },
    'change-diff': { kind: 'panel', render: DiffPanel },
    'show-changes': {
      kind: 'command',
      run() {
        context.openPanel('changes');
      },
    },
    glob: {
      kind: 'tool_renderer',
      render: (props: UiToolProps) => <SearchCapture {...props} matches="files" />,
    },
    grep: {
      kind: 'tool_renderer',
      render: (props: UiToolProps) => <SearchCapture {...props} matches="matches" />,
    },
  };
}
