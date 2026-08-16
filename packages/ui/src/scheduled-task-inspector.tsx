// packages/ui/src/scheduled-task-inspector.tsx
//
// The end-panel inspector for one selected task, modelled on the vendor's
// `incident-console` template: identity + status at the top, the actions that
// change it, then its facts as a MetadataList, then its own run history.
//
// This is where every per-row control moved to. Astryx's List guidance is
// explicit that interactive elements do not belong inside an interactive list
// item — nested click targets, confusing focus. Rows are now selectable and
// otherwise inert; the switch, trigger, snooze, edit, duplicate, clear and
// delete controls all live here, where they are plain buttons with room for
// real labels instead of six entries behind a per-row overflow menu.

import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  Button,
  Divider,
  Heading,
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
import {
  formatScheduledTaskRecurrence,
  formatTaskTime,
  formatScheduledTaskDeliveryTargetLabel,
  scheduledTaskStatusLabel,
  runStatusLabel,
} from './scheduled-task-helpers.js';
import { scheduledTaskStatusDotVariant, scheduledTaskRunStatusDotVariant } from './scheduled-task-status.js';
import { getScheduledTaskCopy } from './scheduled-task-copy.js';
import { useUiLocale } from './locale-context.js';

export function ScheduledTaskInspector(props: {
  task: ScheduledTask;
  pendingActionKeys: ReadonlySet<string>;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onDuplicate(): void;
  onTriggerNow(): void;
  onSnooze(): void;
  onClearRunHistory(): void;
  onDelete(): void;
}) {
  const locale = useUiLocale();
  const copy = getScheduledTaskCopy(locale);
  const { task } = props;
  const isAgentTask = task.effect.kind !== 'notify';
  const isTerminal = task.status === 'completed' || task.status === 'expired';
  const lastRun = task.runs[0];
  const pending = Array.from(props.pendingActionKeys).some((key) => key.startsWith(`${task.id}:`));
  const key = (action: string) => props.pendingActionKeys.has(`${task.id}:${action}`);

  return (
    <VStack className="maka-scheduled-task-inspector" gap={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusDot
            variant={scheduledTaskStatusDotVariant(task.status)}
            label={scheduledTaskStatusLabel(task.status, locale)}
          />
          <Text type="supporting" color="secondary">
            {scheduledTaskStatusLabel(task.status, locale)}
          </Text>
          {isAgentTask ? (
            <Text type="supporting" color="secondary">
              · {copy.detail.agentSource}
            </Text>
          ) : null}
        </HStack>
        <Heading level={2}>{task.title}</Heading>
        {task.intent.body ? <Text type="body" color="secondary">{task.intent.body}</Text> : null}
        {isAgentTask ? (
          <Text type="supporting" color="secondary">{copy.detail.agentSourceHint}</Text>
        ) : null}
      </VStack>
      {!isTerminal && (
        <HStack gap={3} vAlign="center">
          <StackItem size="fill">
            <Switch
              value={task.status === 'active'}
              isDisabled={pending}
              label={copy.detail.enabled}
              onChange={(next) => props.onToggle(next)}
            />
          </StackItem>
        </HStack>
      )}
      <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            label={key('trigger') ? copy.page.triggering : copy.page.triggerNow}
            isDisabled={pending || task.status !== 'active'}
            onClick={props.onTriggerNow}
          />
          <Button
            size="sm"
            variant="secondary"
            label={key('snooze') ? copy.page.snoozing : copy.page.snooze}
            isDisabled={
              pending
              || task.status !== 'active'
              || task.nextFireAt === null
            }
            onClick={props.onSnooze}
          />
      </HStack>
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
          <Text type="body">
            {formatScheduledTaskDeliveryTargetLabel(task.effect, locale)}
          </Text>
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
              onClick={props.onClearRunHistory}
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
          /* A quiet line, not a full EmptyState: the panel is already narrow
             and this is one empty section inside it, not an empty page. */
          (<Text type="supporting" color="secondary">{copy.detail.noRuns}</Text>)
        )}
      </VStack>
      <Divider />
      <HStack gap={2} wrap="wrap">
        {!isAgentTask ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              label={copy.page.edit}
              isDisabled={pending || isTerminal}
              onClick={props.onEdit}
            />
            <Button
              size="sm"
              variant="secondary"
              label={copy.page.duplicate}
              isDisabled={pending}
              onClick={props.onDuplicate}
            />
          </>
        ) : null}
        <StackItem size="fill" />
        <Button
          size="sm"
          variant="destructive"
          label={key('delete') ? copy.page.deleting : copy.page.delete}
          isDisabled={pending}
          onClick={props.onDelete}
        />
      </HStack>
    </VStack>
  );
}
