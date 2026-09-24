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

import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  Button,
  Divider,
  HStack,
  List,
  ListItem,
  StackItem,
  StatusDot,
  Switch,
  Text,
  VStack,
} from '@astryxdesign/core';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import type { ModulePageDetail } from './primitives/module-page.js';
import {
  formatScheduledTaskRecurrence,
  formatTaskTime,
  formatScheduledTaskDeliveryTargetLabel,
  scheduledTaskStatusLabel,
  runStatusLabel,
} from './scheduled-task-helpers.js';
import { scheduledTaskRunStatusDotVariant } from './scheduled-task-status.js';
import { getScheduledTaskCopy } from './scheduled-task-copy.js';

export interface ScheduledTaskDetailActions {
  pendingActionKeys: ReadonlySet<string>;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onDuplicate(): void;
  onTriggerNow(): void;
  onSnooze(): void;
  onClearRunHistory(): void;
  onDelete(): void;
}

export function scheduledTaskDetail(
  task: ScheduledTask,
  locale: UiLocale,
  actions: ScheduledTaskDetailActions,
): ModulePageDetail {
  const copy = getScheduledTaskCopy(locale);
  const isAgentTask = task.effect.kind !== 'notify';
  const isTerminal = task.status === 'completed' || task.status === 'expired';
  const lastRun = task.runs[0];
  const pending = Array.from(actions.pendingActionKeys).some((key) => key.startsWith(`${task.id}:`));
  const key = (action: string) => actions.pendingActionKeys.has(`${task.id}:${action}`);
  const statusLabel = scheduledTaskStatusLabel(task.status, locale);

  return {
    title: task.title,
    subtitle: isAgentTask ? `${statusLabel} · ${copy.detail.agentSource}` : statusLabel,
    content: (
      <VStack gap={4}>
        {task.intent.body || isAgentTask ? (
          <VStack gap={1}>
            {task.intent.body ? <Text type="body">{task.intent.body}</Text> : null}
            {isAgentTask ? <Text type="supporting" color="secondary">{copy.detail.agentSourceHint}</Text> : null}
          </VStack>
        ) : null}
        {!isTerminal ? (
          <HStack gap={3} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <Switch
                value={task.status === 'active'}
                isDisabled={pending}
                label={copy.detail.enabled}
                onChange={(next) => actions.onToggle(next)}
              />
            </StackItem>
            <Button
              size="sm"
              variant="secondary"
              label={key('snooze') ? copy.page.snoozing : copy.page.snooze}
              isDisabled={pending || task.status !== 'active' || task.nextFireAt === null}
              onClick={actions.onSnooze}
            />
            <Button
              size="sm"
              label={key('trigger') ? copy.page.triggering : copy.page.triggerNow}
              isDisabled={pending || task.status !== 'active'}
              onClick={actions.onTriggerNow}
            />
          </HStack>
        ) : null}
        <Divider />
        <MetadataList columns="single" label={{ position: 'start', width: 88 }}>
          <MetadataListItem label={copy.detail.recurrence}>
            <Text type="body">{formatScheduledTaskRecurrence(task, locale)}</Text>
          </MetadataListItem>
          <MetadataListItem label={copy.detail.nextRun}>
            <Text type="body">
              {task.nextFireAt ? formatTaskTime(task.nextFireAt, locale) : copy.page.unscheduled}
            </Text>
          </MetadataListItem>
          {lastRun ? (
            <MetadataListItem label={copy.detail.lastRun}>
              <Text type="body">{formatTaskTime(lastRun.at, locale)}</Text>
            </MetadataListItem>
          ) : null}
          <MetadataListItem label={copy.detail.delivery}>
            <Text type="body">{formatScheduledTaskDeliveryTargetLabel(task.effect, locale)}</Text>
          </MetadataListItem>
          <MetadataListItem label={copy.detail.created}>
            <Text type="body">{formatTaskTime(task.createdAt, locale)}</Text>
          </MetadataListItem>
        </MetadataList>
        <Divider />
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <Text type="label" color="secondary">{copy.detail.runs}</Text>
            </StackItem>
            {task.runs.length > 0 && !isTerminal ? (
              <Button
                size="sm"
                variant="ghost"
                label={key('clear-runs') ? copy.page.clearing : copy.page.clearRuns}
                isDisabled={pending}
                onClick={actions.onClearRunHistory}
              />
            ) : null}
          </HStack>
          {task.runs.length > 0 ? (
            <List density="compact" hasDividers>
              {[...task.runs].sort((a, b) => b.at - a.at).map((run) => (
                <ListItem
                  key={run.id}
                  label={formatTaskTime(run.at, locale)}
                  description={run.message}
                  startContent={
                    <StatusDot
                      variant={scheduledTaskRunStatusDotVariant(run.outcome)}
                      label={runStatusLabel(run.outcome, locale)}
                    />
                  }
                />
              ))}
            </List>
          ) : (
            <Text type="supporting" color="secondary">{copy.detail.noRuns}</Text>
          )}
        </VStack>
      </VStack>
    ),
    footer: (
      <HStack gap={2} vAlign="center">
        <Button
          variant="destructive"
          label={key('delete') ? copy.page.deleting : copy.page.delete}
          isDisabled={pending}
          onClick={actions.onDelete}
        />
        <StackItem size="fill" />
        {!isAgentTask ? (
          <>
            <Button variant="secondary" label={copy.page.duplicate} isDisabled={pending} onClick={actions.onDuplicate} />
            <Button variant="secondary" label={copy.page.edit} isDisabled={pending || isTerminal} onClick={actions.onEdit} />
          </>
        ) : null}
      </HStack>
    ),
  };
}
