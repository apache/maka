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

/**
 * ScheduledTask create/edit form dialog (issue #1044).
 *
 * Owns ALL form state + the submit pipeline that used to live inline in
 * `scheduled-task-panel.tsx`: the nine field states, editingId, the
 * submitPending single-flight owner, validation, and the close guard. The
 * panel keeps only list/runs/query state and opens this dialog with a
 * `ScheduledTaskFormSeed`. It remounts each form session so Astryx receives a
 * fresh native dialog with the selected seed.
 *
 * Async-owner invariants (pinned by scheduled-task-panel-contract):
 *   - submit rejects re-entry synchronously via submitPendingRef before
 *     React commits the disabled state;
 *   - the dialog refuses to close while a submit is in flight;
 *   - the pending owner is released on unmount without writing React state.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { BotBrandLogo } from './bot-brand-logo.js';
import type { BotProvider } from '@maka/core/bot-chat-settings';
import type { ScheduledTask, ScheduledTaskSchedule } from '@maka/core/scheduled-task';
import { BOT_DELIVERY_PROVIDERS } from '@maka/core/bot-chat-settings';
import { botDisplayLabel } from '@maka/core/bot-events';
import {
  type ScheduledTaskFormSeed,
  formatScheduledTaskDeliveryProviderList,
  scheduledTaskFormValidation,
  scheduledTaskPresetRunAt,
  scheduledTaskTemplateSeed,
  toScheduledTaskLocalDateTimeValue,
} from './scheduled-task-helpers.js';
import {
  Button as UiButton,
  DateTimeInput,
  HStack,
  Selector,
  Text,
  TextArea as UiTextarea,
  TextInput,
} from '@astryxdesign/core';
import type { ISODateTimeString } from '@astryxdesign/core/DateTimeInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import {
  getScheduledTaskCopy,
  type ScheduledTaskExampleTemplate,
} from './scheduled-task-copy.js';
import { useUiLocale } from './locale-context.js';
import type {
  ScheduledTaskDelivery,
  ScheduledTaskDeliveryMethod,
  ScheduledTaskDraftInput,
  ScheduledTaskRecurrence,
  ScheduledTaskUpdatePatch,
} from './module-panel-types.js';

export function ScheduledTaskFormDialog(props: {
  open: boolean;
  seed: ScheduledTaskFormSeed;
  /** Current tasks, so an open edit form resets if its task vanishes. */
  tasks: ScheduledTask[];
  onOpenChange(open: boolean): void;
  onCreate?(input: ScheduledTaskDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: ScheduledTaskUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
}) {
  const locale = useUiLocale();
  const catalog = getScheduledTaskCopy(locale);
  const copy = catalog.form;
  const templates = catalog.templates;
  const [title, setTitle] = useState(props.seed.title);
  const [note, setNote] = useState(props.seed.note);
  const [runAtLocal, setRunAtLocal] = useState(props.seed.runAtLocal);
  const [recurrence, setRecurrence] = useState<ScheduledTaskRecurrence>(props.seed.recurrence);
  const [cronExpression, setCronExpression] = useState(props.seed.cronExpression);
  const [deliveryMethod, setDeliveryMethod] = useState<ScheduledTaskDeliveryMethod>(props.seed.deliveryMethod);
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>(props.seed.deliveryPlatform);
  const [deliveryChatId, setDeliveryChatId] = useState(props.seed.deliveryChatId);
  const [editingId, setEditingId] = useState<string | null>(props.seed.editingId);
  const [submitPending, setSubmitPending] = useState(false);
  // The empty form is invalid by definition; showing the title error before
  // the user has typed anything reads as a scolding. Gate it on first input.
  const [titleTouched, setTitleTouched] = useState(false);
  const scheduledTaskMountedRef = useMountedRef();
  const submitPendingRef = useRef(false);
  const parsedRunAt = Date.parse(runAtLocal);
  const effect = deliveryMethod === 'agent_run'
    ? props.seed.lockedEffect
    : deliveryMethod === 'bot'
      ? { kind: 'notify' as const, channel: 'bot' as const, platform: deliveryPlatform, chatId: deliveryChatId.trim() }
      : { kind: 'notify' as const, channel: 'local' as const };
  const validation = scheduledTaskFormValidation({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery: effect ?? { kind: 'notify', channel: 'local' },
    now: Date.now(),
  }, locale);
  const canCreate =
    validation === null &&
    effect !== undefined &&
    (recurrence !== 'interval' || props.seed.lockedSchedule !== undefined);
  const submitDisabled = !canCreate || submitPending;
  const formInteractionDisabled = submitPending;
  const isEditing = editingId !== null;

  useEffect(() => {
    return () => {
      submitPendingRef.current = false;
    };
  }, []);

  // No focus effect here. Initial focus is the title field's own
  // `hasAutoFocus` (which is what emits the `data-autofocus` hook Astryx's
  // Dialog looks for), and the panel that opens this dialog owns handing focus
  // back to whatever opened it.

  useEffect(() => {
    if (editingId && !props.tasks.some((task) => task.id === editingId)) resetForm();
  }, [editingId, props.tasks]);

  function resetForm() {
    setTitle('');
    setNote('');
    setRecurrence('none');
    setCronExpression('0 9 * * 1-5');
    setDeliveryMethod('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toScheduledTaskLocalDateTimeValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
    setTitleTouched(false);
  }

  function closeTaskDialog() {
    if (submitPendingRef.current) return;
    props.onOpenChange(false);
    resetForm();
  }

  function applyTemplate(template: ScheduledTaskExampleTemplate) {
    const seed = scheduledTaskTemplateSeed(template);
    setTitle(seed.title);
    setNote(seed.note);
    setRunAtLocal(seed.runAtLocal);
    setRecurrence(seed.recurrence);
    setCronExpression(seed.cronExpression);
    setDeliveryMethod(seed.deliveryMethod);
    setDeliveryPlatform(seed.deliveryPlatform);
    setDeliveryChatId(seed.deliveryChatId);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || submitPendingRef.current) return;
    if (!effect) return;
    let schedule: ScheduledTaskSchedule;
    if (recurrence === 'interval') {
      if (!props.seed.lockedSchedule) return;
      schedule = props.seed.lockedSchedule;
    } else if (recurrence === 'none') {
      schedule = { kind: 'once', runAt: parsedRunAt };
    } else if (recurrence === 'cron') {
      schedule = { kind: 'cron', expression: cronExpression.trim(), startAt: parsedRunAt };
    } else {
      schedule = { kind: 'calendar', recurrence, anchorAt: parsedRunAt };
    }
    submitPendingRef.current = true;
    const input = {
      title: title.trim(),
      intentBody: note.trim(),
      schedule,
      effect,
    };
    setSubmitPending(true);
    try {
      const result = editingId
        ? await props.onUpdate?.(editingId, input)
        : await props.onCreate?.(input);
      if (result !== false && scheduledTaskMountedRef.current) {
        resetForm();
        props.onOpenChange(false);
      }
    } finally {
      submitPendingRef.current = false;
      if (scheduledTaskMountedRef.current) setSubmitPending(false);
    }
  }

  // Astryx Dialog, purpose="form": the vendor's explicit guidance for a
  // dialog that holds inputs — the backdrop cannot dismiss it, so a
  // half-filled task is never lost to a stray click, while Escape, focus
  // trapping and focus restoration come from the native <dialog>.
  //
  // Shaped after the vendor's own `DialogFormDialog` block: header, a vertical
  // FormLayout of plain labelled fields, footer. Everything the form used to
  // draw itself — the borderless display-size title input, the two grey inset
  // group boxes with their own labels, the ghost "value ⌄" menus standing in
  // for selects, the quick-time button row — is gone. One control idiom, one
  // surface, and the only type sizes left are the field label and body text
  // that Astryx's own inputs bring.
  return (
    <Dialog
      isOpen={props.open}
      onOpenChange={(open) => {
        if (!open) closeTaskDialog();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        header={(
          <DialogHeader
            title={isEditing ? copy.editTitle : copy.createTitle}
            onOpenChange={(open) => {
              if (!open) closeTaskDialog();
            }}
            endContent={!isEditing ? (
              <DropdownMenu
                button={{
                  label: copy.useTemplate,
                  variant: 'ghost',
                  size: 'sm',
                  isDisabled: formInteractionDisabled,
                }}
                menuWidth={240}
              >
                {templates.map((template) => (
                  <DropdownMenuItem
                    key={template.id}
                    onClick={() => applyTemplate(template)}
                    label={template.title}
                    endContent={template.scheduleLabel}
                  />
                ))}
              </DropdownMenu>
            ) : undefined}
          />
        )}
        content={(
          <LayoutContent>
            <form
              id="maka-scheduled-task-form"
              onSubmit={submit}
              aria-busy={submitPending ? 'true' : undefined}
            >
              <FormLayout>
                {/* `isRequired` is the ONLY way to get `aria-required` onto an
                    Astryx field: it writes `aria-required` after spreading
                    `...rest`, so passing the attribute through is silently
                    dropped (TextInput.tsx). Its visible marker is localized
                    through the vendor patch (#2184), so the prop now costs
                    nothing to carry. */}
                <TextInput
                  label={copy.field.title}
                  isRequired
                  value={title}
                  onChange={(value) => {
                    setTitleTouched(true);
                    setTitle(value.slice(0, 120));
                  }}
                  placeholder={copy.titlePlaceholder}
                  hasAutoFocus
                  isDisabled={formInteractionDisabled}
                  status={titleTouched && validation?.field === 'title'
                    ? { type: 'error', message: validation.message }
                    : undefined}
                />
                <UiTextarea
                  label={copy.field.note}
                  value={note}
                  onChange={(value) => setNote(value.slice(0, 8000))}
                  rows={3}
                  placeholder={copy.notePlaceholder}
                  isDisabled={formInteractionDisabled}
                />
                {/* Open groups, not boxes. The form asks three different
                    questions — what to say, when to fire, where to send — and
                    a flat run of eight fields makes the reader re-derive that
                    from the labels each time. The grouping is information
                    architecture, so it stays.

                    What does NOT come back is the pair of grey inset cards
                    this used to draw. Those were designed for a non-modal
                    aside floating beside the page, where a group needed a card
                    to cut itself out of its surroundings; inside a Dialog the
                    surface is already its own, and a filled card on it would
                    be the card-in-a-card this app's settings rules forbid. A
                    label and the layout's own spacing carry the same structure
                    on one surface. */}
                <Text type="supporting" weight="medium">{copy.groupSchedule}</Text>
                <DateTimeInput
                  label={copy.field.time}
                  isRequired
                  value={(runAtLocal || undefined) as ISODateTimeString | undefined}
                  onChange={(value) => setRunAtLocal(value ?? '')}
                  isDisabled={formInteractionDisabled || recurrence === 'interval'}
                  hourFormat="24h"
                  timeIncrement={5}
                  width="100%"
                  status={validation?.field === 'time'
                    ? { type: 'error', message: validation.message }
                    : undefined}
                />
                {/* One tap for the times people actually pick. The picker
                    above can express any instant, which is why it stays, but
                    reaching "in an hour" through a calendar costs a date, an
                    hour and a minute to say something the user already knows
                    in full. These are a shortcut past that, not a second way
                    to enter a time: each one writes the same field, which then
                    shows the result and remains editable.

                    They set `runAtLocal` only — recurrence is a separate
                    question, so choosing 明天 9 点 on a weekly task moves
                    the next occurrence without silently making it one-off. */}
                <HStack gap={2} wrap="wrap" role="group" aria-label={copy.presetsAriaLabel}>
                  {copy.presets.map(([preset, label]) => (
                    <UiButton
                      key={preset}
                      variant="secondary"
                      size="sm"
                      label={label}
                      isDisabled={formInteractionDisabled || recurrence === 'interval'}
                      onClick={() => setRunAtLocal(
                        toScheduledTaskLocalDateTimeValue(scheduledTaskPresetRunAt(preset)),
                      )}
                    />
                  ))}
                </HStack>
                <Selector
                  label={copy.field.recurrence}
                  value={recurrence}
                  onChange={(value) => setRecurrence(value as ScheduledTaskRecurrence)}
                  options={(recurrence === 'interval'
                    ? [['interval', copy.intervalOption] as const]
                    : copy.recurrenceOptions
                  ).map(([value, label]) => ({ value, label }))}
                  isDisabled={formInteractionDisabled || recurrence === 'interval'}
                  width="100%"
                />
                {recurrence === 'cron' && (
                  <TextInput
                    label={copy.field.cron}
                    isRequired
                    value={cronExpression}
                    onChange={(value) => setCronExpression(value.slice(0, 80))}
                    placeholder={copy.cronPlaceholder}
                      isDisabled={formInteractionDisabled}
                    width="100%"
                    status={validation?.field === 'cron'
                      ? { type: 'error', message: validation.message }
                      : undefined}
                  />
                )}
                <Text type="supporting" weight="medium">{copy.groupDelivery}</Text>
                <Selector
                  label={copy.field.channel}
                  value={deliveryMethod}
                  onChange={(value) => setDeliveryMethod(value as ScheduledTaskDelivery['channel'])}
                  options={(deliveryMethod === 'agent_run'
                    ? [['agent_run', copy.agentRunOption] as const]
                    : copy.deliveryOptions
                  ).map(([value, label]) => ({ value, label }))}
                  isDisabled={formInteractionDisabled || deliveryMethod === 'agent_run'}
                  width="100%"
                />
                {deliveryMethod === 'bot' && (
                  <>
                    <Selector
                      label={copy.field.platform}
                      /* The "why is my platform missing" answer rides the field
                         it answers for, as Selector's own description slot —
                         not a loose paragraph in a third type size. */
                      description={copy.deliveryHelp(formatScheduledTaskDeliveryProviderList())}
                      value={deliveryPlatform}
                      onChange={(value) => setDeliveryPlatform(value as BotProvider)}
                      options={BOT_DELIVERY_PROVIDERS.map((provider) => ({
                        value: provider,
                        label: botDisplayLabel(provider),
                        icon: <BotBrandLogo provider={provider} width={16} height={16} aria-hidden="true" />,
                      }))}
                      isDisabled={formInteractionDisabled}
                      width="100%"
                    />
                    <TextInput
                      label={copy.field.chatId}
                      isRequired
                      value={deliveryChatId}
                      onChange={(value) => setDeliveryChatId(value.slice(0, 160))}
                      placeholder={copy.chatIdPlaceholder}
                          isDisabled={formInteractionDisabled}
                      width="100%"
                      status={validation?.field === 'chatId'
                        ? { type: 'error', message: validation.message }
                        : undefined}
                    />
                  </>
                )}
              </FormLayout>
            </form>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            {/* One button. The dialog already offers two ways out — the
                header's close control and Escape — so a footer 取消 would be a
                third route to the same place. */}
            <HStack gap={2} hAlign="end">
              <UiButton
                variant="primary"
                type="submit"
                form="maka-scheduled-task-form"
                isDisabled={submitDisabled}
                label={submitPending ? (isEditing ? copy.saving : copy.creating) : (isEditing ? copy.save : copy.create)}
              />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}
