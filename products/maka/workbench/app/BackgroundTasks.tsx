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

import { cleanup, computed, effect, inputAction, Scroll, signal, Text, View } from 'nsh';
import type { ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import type {
  ComposerBackgroundTask,
  ComposerBackgroundTasks,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { formatDuration } from './duration';
import { Icon } from './Icon';
import { tr } from './locale';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { terminalStatus } from './terminalState';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  textTooltip,
} from './ui';

const failed = (task: ComposerBackgroundTask) =>
  task.status === 'failed' ||
  task.status === 'timed_out' ||
  (task.exitCode !== undefined && task.exitCode !== 0);

/** The composer detail panel for a conversation's background agent commands. */
export function createBackgroundTaskPanel(tasks: ComposerBackgroundTasks, height: () => number) {
  const clock = signal(Date.now());
  const finishedOpen = signal(false);
  const confirming = signal<ComposerBackgroundTask | null>(null);
  // Close the question once the task ends on its own.
  effect(() => {
    const target = confirming();
    if (target && !tasks.running().some((task) => task.ref === target.ref && task.stoppable))
      confirming.set(null);
  });
  const running = () => tasks.running().length;
  const finished = () => tasks.finished().length;
  // One clock for every row, ticking only while something runs.
  effect(() => {
    if (running() === 0) return;
    clock.set(Date.now());
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  const elapsed = (task: ComposerBackgroundTask) =>
    formatDuration(Math.max(0, (task.completedAt ?? clock()) - task.startedAt));
  const detail = (task: ComposerBackgroundTask) =>
    task.status === 'starting' || task.status === 'running'
      ? elapsed(task)
      : [
          terminalStatus(task.status),
          task.exitCode === undefined ? '' : tr('Exit {code}', { code: String(task.exitCode) }),
          task.completedAt === undefined ? '' : elapsed(task),
        ]
          .filter(Boolean)
          .join(' · ');
  const row = (task: () => ComposerBackgroundTask) => {
    const live = () => task().status === 'starting' || task().status === 'running';
    let node: ViewRef | undefined;
    cleanup(() => {
      node = undefined;
    });
    const content = () => (
      <>
        <Icon name="terminal" size={14} color={C.muted} />
        <Text
          style={[
            { ...codeTextStyle, flex: 1, minWidth: 0, color: live() ? C.text : C.secondary },
            { numberOfLines: 1, textOverflow: 'ellipsis' },
          ]}
        >
          {task().command}
        </Text>
        <Text
          style={{
            ...captionTextStyle,
            flexShrink: 0,
            color: !live() && failed(task()) ? C.warning : C.muted,
          }}
        >
          {detail(task())}
        </Text>
      </>
    );
    const rowStyle = {
      ...controlStyle,
      flex: 1,
      minWidth: 0,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
    };
    const stopping = () => tasks.stopping(task().ref);
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        <If when={!!tasks.open} else={<View style={rowStyle}>{content()}</View>}>
          <Button
            ref={(value) => {
              node = value;
            }}
            accessibilityLabel={tr('Open output of {command}', { command: task().command })}
            tooltip={textTooltip(() => task().command)}
            onPress={() =>
              tasks.open?.(task().ref, () => {
                if (!node) return false;
                node.focus();
                return true;
              })
            }
            style={rowStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            {content()}
          </Button>
        </If>
        <If when={task().stoppable || stopping()}>
          <Button
            disabled={stopping()}
            accessibilityLabel={tr('Stop {command}', { command: task().command })}
            tooltip={textTooltip(() => (stopping() ? tr('Stopping…') : tr('Stop task')))}
            onPress={() => confirming.set(task())}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="stop" color={stopping() ? C.muted : C.warning} />
          </Button>
        </If>
      </View>
    );
  };
  const finishedRows = computed(() => (finishedOpen() ? tasks.finished() : []));
  return {
    shown: () => running() + finished() > 0 || !!tasks.error(),
    summary: () =>
      running() > 0
        ? tr('{count} running', { count: String(running()) })
        : finished() > 0
          ? tr('{count} finished', { count: String(finished()) })
          : '',
    preview: () => tasks.error() || (tasks.running()[0]?.command ?? ''),
    problem: () => !!tasks.error(),
    content: () => (
      <View style={{ minHeight: 0, flexShrink: 1 }}>
        <Scroll
          accessibilityLabel={tr('Background tasks')}
          style={{ minHeight: 0, maxHeight: height(), flexShrink: 1, flexGrow: 0 }}
          contentStyle={{ padding: 8 }}
        >
          <View style={{ gap: 2 }}>
            <Each of={tasks.running()} key={(task) => task.ref}>
              {(task) => row(task)}
            </Each>
            <If when={finished() > 0}>
              <Button
                accessibilityLabel={tr('Finished commands')}
                selected={finishedOpen()}
                onPress={() => finishedOpen.set(!finishedOpen())}
                style={{
                  ...controlStyle,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: 8,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name={finishedOpen() ? 'down' : 'right'} size={14} color={C.muted} />
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('{count} finished', { count: String(finished()) })}
                </Text>
              </Button>
            </If>
            <Each of={finishedRows()} key={(task) => task.ref}>
              {(task) => row(task)}
            </Each>
            <If when={tasks.error()}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4 }}>
                <Text
                  style={[{ ...bodyTextStyle, flex: 1, color: C.danger }, { userSelect: 'text' }]}
                >
                  {tasks.error()}
                </Text>
                <Button
                  accessibilityLabel={tr('Refresh background tasks')}
                  tooltip={textTooltip(() => tr('Refresh background tasks'))}
                  onPress={inputAction(tasks.refresh, null)}
                  style={controlStyle}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Icon name="refresh" color={C.secondary} />
                </Button>
              </View>
            </If>
          </View>
        </Scroll>
        <If when={confirming()}>
          <ModalDialog size="alert" onCancel={() => confirming.set(null)}>
            <DialogHeader
              title={tr('Stop this background task?')}
              detail={`${confirming()?.command ?? ''}\n${tr('The agent sees it as stopped and may start it again.')}`}
            />
            <DialogFooter>
              <SettingsButton
                label={tr('Cancel')}
                tone="quiet"
                autoFocus
                onPress={() => confirming.set(null)}
              />
              <SettingsButton
                label={tr('Stop task')}
                tone="danger"
                onPress={() => {
                  const target = confirming();
                  confirming.set(null);
                  if (target) void tasks.stop(target.ref);
                }}
              />
            </DialogFooter>
          </ModalDialog>
        </If>
      </View>
    ),
  };
}
