// packages/ui/src/plan-reminder-inspector.tsx
//
// The end-panel inspector for one selected reminder, modelled on the vendor's
// `incident-console` template: identity + status at the top, the actions that
// change it, then its facts as a MetadataList, then its own run history.
//
// This is where every per-row control moved to. Astryx's List guidance is
// explicit that interactive elements do not belong inside an interactive list
// item — nested click targets, confusing focus. Rows are now selectable and
// otherwise inert; the switch, trigger, snooze, edit, duplicate, clear and
// delete controls all live here, where they are plain buttons with room for
// real labels instead of six entries behind a per-row overflow menu.

import type { PlanReminder } from '@maka/core';
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
  formatPlanRecurrence,
  formatReminderTime,
  formatPlanReminderDeliveryTargetLabel,
  planReminderStatusLabel,
  runStatusLabel,
} from './plan-reminder-helpers.js';
import { planReminderStatusDotVariant, planRunStatusDotVariant } from './plan-reminder-status.js';
import { getPlanReminderCopy } from './plan-reminder-copy.js';
import { useUiLocale } from './locale-context.js';

export function PlanReminderInspector(props: {
  reminder: PlanReminder;
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
  const copy = getPlanReminderCopy(locale);
  const { reminder } = props;
  const isCompleted = reminder.status === 'completed';
  const pending = Array.from(props.pendingActionKeys).some((key) => key.startsWith(`${reminder.id}:`));
  const key = (action: string) => props.pendingActionKeys.has(`${reminder.id}:${action}`);

  return (
    <VStack className="maka-plan-inspector" gap={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusDot
            variant={planReminderStatusDotVariant(reminder.status)}
            label={planReminderStatusLabel(reminder.status, locale)}
          />
          <Text type="supporting" color="secondary">
            {planReminderStatusLabel(reminder.status, locale)}
          </Text>
        </HStack>
        <Heading level={2}>{reminder.title}</Heading>
        {reminder.note ? <Text type="body" color="secondary">{reminder.note}</Text> : null}
      </VStack>

      {!isCompleted && (
        <HStack gap={3} vAlign="center">
          <StackItem size="fill">
            <Switch
              value={reminder.enabled}
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
          isDisabled={pending || !reminder.enabled}
          onClick={props.onTriggerNow}
        />
        <Button
          size="sm"
          variant="secondary"
          label={key('snooze') ? copy.page.snoozing : copy.page.snooze}
          isDisabled={
            pending
            || !reminder.enabled
            || reminder.status !== 'scheduled'
            || typeof reminder.nextRunAt !== 'number'
          }
          onClick={props.onSnooze}
        />
      </HStack>

      <Divider />

      <MetadataList columns="single" label={{ position: 'start', width: 88 }}>
        <MetadataListItem label={copy.detail.recurrence}>
          <Text type="body">{formatPlanRecurrence(reminder, locale)}</Text>
        </MetadataListItem>
        <MetadataListItem label={copy.detail.nextRun}>
          <Text type="body">
            {reminder.nextRunAt ? formatReminderTime(reminder.nextRunAt, locale) : copy.page.unscheduled}
          </Text>
        </MetadataListItem>
        {reminder.lastRun ? (
          <MetadataListItem label={copy.detail.lastRun}>
            <Text type="body">{formatReminderTime(reminder.lastRun.at, locale)}</Text>
          </MetadataListItem>
        ) : null}
        <MetadataListItem label={copy.detail.delivery}>
          <Text type="body">{formatPlanReminderDeliveryTargetLabel(reminder.delivery, locale)}</Text>
        </MetadataListItem>
        <MetadataListItem label={copy.detail.created}>
          <Text type="body">{formatReminderTime(reminder.createdAt, locale)}</Text>
        </MetadataListItem>
      </MetadataList>

      <Divider />

      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text type="label" color="secondary">{copy.detail.runs}</Text>
          </StackItem>
          {reminder.runs.length > 0 && !isCompleted ? (
            <Button
              size="sm"
              variant="ghost"
              label={key('clear-runs') ? copy.page.clearing : copy.page.clearRuns}
              isDisabled={pending}
              onClick={props.onClearRunHistory}
            />
          ) : null}
        </HStack>
        {reminder.runs.length > 0 ? (
          <List density="compact" hasDividers>
            {[...reminder.runs].sort((a, b) => b.at - a.at).map((run) => (
              <ListItem
                key={run.id}
                label={formatReminderTime(run.at, locale)}
                description={run.message}
                startContent={
                  <StatusDot
                    variant={planRunStatusDotVariant(run.status)}
                    label={runStatusLabel(run.status, locale)}
                  />
                }
              />
            ))}
          </List>
        ) : (
          /* A quiet line, not a full EmptyState: the panel is already narrow
             and this is one empty section inside it, not an empty page. */
          <Text type="supporting" color="secondary">{copy.detail.noRuns}</Text>
        )}
      </VStack>

      <Divider />

      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant="secondary"
          label={copy.page.edit}
          isDisabled={pending || isCompleted}
          onClick={props.onEdit}
        />
        <Button size="sm" variant="secondary" label={copy.page.duplicate} isDisabled={pending} onClick={props.onDuplicate} />
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
