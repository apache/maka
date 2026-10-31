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
import { inputAction, Text } from 'nsh';
import { Button } from 'nsh/base';
import type {
  ComposerPlan,
  PendingComposerPermissions,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { CollaborationMode } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  textTooltip,
  toolbarControlStyle,
} from './ui';

/** Plan first: the conversation proposes a plan for approval before it changes anything. */
export function PlanModeToggle(props: {
  plan: ComposerPlan | null;
  pending: PendingComposerPermissions | null;
  /** The Host only switches modes while the conversation is idle. */
  busy: boolean;
}) {
  const mode = (): CollaborationMode | null =>
    props.plan ? props.plan.mode() : props.pending ? props.pending.mode() : null;
  const shown = () =>
    props.plan ? !!props.plan.view()?.enabled : (props.pending?.mode() ?? null) !== null;
  // Changing mode changes the conversation's boundary, which would stop an
  // approved Plan that has not finished.
  const running = () => {
    const phase = props.plan?.view()?.current.execution?.phase;
    return phase === 'awaiting_admission' || phase === 'active';
  };
  const busy = () => !!props.plan && (props.busy || running());
  const disabled = () =>
    mode() === null || (props.plan ? props.plan.pending() || busy() : !!props.pending?.pending());
  const planning = () => mode() === 'plan';
  const select = (next: CollaborationMode) => {
    if (props.plan) void props.plan.selectMode(next);
    else props.pending?.selectMode(next);
  };
  return (
    <If when={shown()}>
      <Button
        disabled={disabled()}
        selected={planning()}
        accessibilityLabel={tr('Planning mode')}
        tooltip={textTooltip(() =>
          busy()
            ? tr(
                'Wait for the current execution and queued messages to finish before switching mode.',
              )
            : planning()
              ? tr('Switch to Agent mode')
              : tr(
                  'Planning can inspect and ask questions. Implementation starts only after you approve a submitted Plan.',
                ),
        )}
        onPress={inputAction(select, planning() ? 'agent' : 'plan')}
        style={{
          ...toolbarControlStyle,
          flexShrink: 0,
          backgroundColor: planning() ? C.raised : 'transparent',
        }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text
          style={[
            { ...captionTextStyle, color: planning() ? C.accent : C.muted },
            { numberOfLines: 1 },
          ]}
        >
          {tr('Plan')}
        </Text>
      </Button>
    </If>
  );
}
