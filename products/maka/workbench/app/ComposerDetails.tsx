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
  platform,
  signal,
  Text,
  View,
  windowSize,
} from 'nsh';
import { Button } from 'nsh/base';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { createChecklist } from './Checklist';
import { createPlanPanel } from './PlanPanel';
import { createComputerAppControls } from './ComputerAppControls';
import { createQueueDock } from './QueueDock';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, captionTextStyle, controlStyle, textTooltip } from './ui';

export function ComposerDetails(props: {
  session: Pick<ComposerSession, 'checklist' | 'computerAccess' | 'plan' | 'queue' | 'connected'>;
}) {
  const session = props.session;
  const height = () => windowSize().height / 4;
  const panels = {
    plan: createPlanPanel(session.plan),
    todo: createChecklist(session.checklist, height),
    computer: createComputerAppControls(session.computerAccess, height),
    queue: createQueueDock(session.queue, height, session.connected),
  };
  type Panel = keyof typeof panels;
  const keys: Panel[] = ['plan', 'todo', 'computer', 'queue'];
  const available = computed(() => keys.filter((key) => panels[key].shown()));
  const selected = signal<Panel | null>(null);
  const previewed = () => available().length === 1 && selected() === null;
  const labels = {
    plan: () => tr('Plan'),
    todo: () => tr('Todo'),
    computer: () => tr('Computer access'),
    queue: () => tr('Queued messages'),
  };
  const accessibilityLabels = {
    plan: () => tr('Toggle plan'),
    todo: () => tr('Toggle conversation todo'),
    computer: () => tr('Toggle computer access'),
    queue: () => tr('Queued messages'),
  };
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const toggle = (key: Panel) => {
    if (alive && panels[key].shown()) selected.set(selected() === key ? null : key);
  };
  effect(() => {
    const current = selected();
    if (current !== null && !panels[current].shown()) selected.set(null);
  });
  // A proposal waiting for approval opens the plan once; closing it is kept.
  let attended: string | null = null;
  effect(() => {
    const attention = panels.plan.attention();
    if (attention !== null && attention !== attended && panels.plan.shown()) selected.set('plan');
    attended = attention;
  });
  return (
    <If when={available().length > 0}>
      <View
        accessibilityLabel={tr('Conversation details')}
        style={{
          minHeight: 0,
          flexShrink: 1,
          marginBottom: platform.isTerminal ? 16 : 8,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
          backgroundColor: C.surface,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 4, flexShrink: 0 }}>
          <Each of={available()} key={(key) => key}>
            {(item) => {
              const key = item();
              const panel = panels[key];
              return (
                <Button
                  accessibilityLabel={accessibilityLabels[key]()}
                  tooltip={textTooltip(panel.preview)}
                  selected={selected() === key}
                  onPress={inputAction(toggle, key)}
                  style={{
                    ...controlStyle,
                    flexDirection: 'row',
                    gap: 8,
                    alignItems: 'center',
                    flexShrink: 0,
                    backgroundColor: selected() === key ? C.raised : 'transparent',
                  }}
                  hoverStyle={{ backgroundColor: C.raised }}
                  focusStyle={{ backgroundColor: C.line }}
                >
                  <Icon
                    name={
                      key === 'plan'
                        ? 'edit'
                        : key === 'todo'
                          ? 'check'
                          : key === 'computer'
                            ? 'shield'
                            : 'queue'
                    }
                    color={panel.problem() ? C.warning : C.secondary}
                  />
                  <Text style={{ ...captionTextStyle, color: C.text }}>{labels[key]()}</Text>
                  <Text
                    style={{ ...captionTextStyle, color: panel.problem() ? C.warning : C.muted }}
                  >
                    {panel.summary()}
                  </Text>
                  <Icon name={selected() === key ? 'down' : 'right'} color={C.muted} />
                </Button>
              );
            }}
          </Each>
          <Each
            of={available().length === 1 && selected() === null ? available() : []}
            key={(key) => key}
          >
            {(key) => (
              <Text
                style={[
                  {
                    ...captionTextStyle,
                    flex: 1,
                    minWidth: 0,
                    alignSelf: 'center',
                    color: panels[key()].problem() ? C.warning : C.muted,
                  },
                  { numberOfLines: 1 },
                ]}
              >
                {panels[key()].preview()}
              </Text>
            )}
          </Each>
        </View>
        <Each of={selected() === null ? [] : [selected()!]} key={(key) => key}>
          {(key) => (
            <View
              style={{
                minHeight: 0,
                flexShrink: 1,
                // A plan to review needs more room than a list of items.
                maxHeight: key() === 'plan' ? windowSize().height / 2 : height(),
                borderTopWidth: 1,
                borderTopColor: C.line,
              }}
            >
              {panels[key()].content(previewed)}
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
