/**
 * Plan-reminder create/edit form dialog (issue #1044).
 *
 * Owns ALL form state + the submit pipeline that used to live inline in
 * `plan-reminder-panel.tsx`: the nine field states, editingId, the
 * submitPending single-flight owner, validation, and the close guard. The
 * panel keeps only list/runs/query state and opens this dialog with a
 * `PlanReminderFormSeed`. It remounts each form session so Astryx receives a
 * fresh native dialog with the selected seed.
 *
 * Async-owner invariants (pinned by plan-reminder-panel-contract):
 *   - submit rejects re-entry synchronously via submitPendingRef before
 *     React commits the disabled state;
 *   - the dialog refuses to close while a submit is in flight;
 *   - the pending owner is released on unmount without writing React state.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { BotBrandLogo } from './bot-brand-logo.js';
import type {
  BotProvider,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
} from '@maka/core';
import { BOT_DELIVERY_PROVIDERS, botDisplayLabel } from '@maka/core';
import {
  type PlanReminderFormSeed,
  formatPlanDeliveryProviderList,
  planReminderFormValidation,
  planReminderPresetRunAt,
  planReminderTemplateSeed,
  toPlanReminderLocalDateTimeValue,
} from './plan-reminder-helpers.js';
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
  getPlanReminderCopy,
  type PlanReminderExampleTemplate,
} from './plan-reminder-copy.js';
import { useUiLocale } from './locale-context.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';

export function PlanReminderFormDialog(props: {
  open: boolean;
  seed: PlanReminderFormSeed;
  /** Current reminders, so an open edit form resets if its reminder vanishes. */
  reminders: PlanReminder[];
  onOpenChange(open: boolean): void;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
}) {
  const locale = useUiLocale();
  const catalog = getPlanReminderCopy(locale);
  const copy = catalog.form;
  const templates = catalog.templates;
  const [title, setTitle] = useState(props.seed.title);
  const [note, setNote] = useState(props.seed.note);
  const [runAtLocal, setRunAtLocal] = useState(props.seed.runAtLocal);
  const [recurrence, setRecurrence] = useState<PlanReminderRecurrence>(props.seed.recurrence);
  const [cronExpression, setCronExpression] = useState(props.seed.cronExpression);
  const [deliveryChannel, setDeliveryChannel] = useState<PlanReminderDeliveryTarget['channel']>(props.seed.deliveryChannel);
  const [deliveryPlatform, setDeliveryPlatform] = useState<BotProvider>(props.seed.deliveryPlatform);
  const [deliveryChatId, setDeliveryChatId] = useState(props.seed.deliveryChatId);
  const [editingId, setEditingId] = useState<string | null>(props.seed.editingId);
  const [submitPending, setSubmitPending] = useState(false);
  // The empty form is invalid by definition; showing the title error before
  // the user has typed anything reads as a scolding. Gate it on first input.
  const [titleTouched, setTitleTouched] = useState(false);
  const planReminderMountedRef = useMountedRef();
  const submitPendingRef = useRef(false);
  const parsedRunAt = Date.parse(runAtLocal);
  const delivery: PlanReminderDeliveryTarget = deliveryChannel === 'bot'
    ? { channel: 'bot', platform: deliveryPlatform, chatId: deliveryChatId.trim() }
    : { channel: 'local' };
  const validation = planReminderFormValidation({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery,
    now: Date.now(),
  }, locale);
  const canCreate = validation === null;
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
    if (editingId && !props.reminders.some((reminder) => reminder.id === editingId)) resetForm();
  }, [editingId, props.reminders]);

  function resetForm() {
    setTitle('');
    setNote('');
    setRecurrence('none');
    setCronExpression('0 9 * * 1-5');
    setDeliveryChannel('local');
    setDeliveryPlatform('telegram');
    setDeliveryChatId('');
    setRunAtLocal(toPlanReminderLocalDateTimeValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
    setTitleTouched(false);
  }

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    props.onOpenChange(false);
    resetForm();
  }

  function applyTemplate(template: PlanReminderExampleTemplate) {
    const seed = planReminderTemplateSeed(template);
    setTitle(seed.title);
    setNote(seed.note);
    setRunAtLocal(seed.runAtLocal);
    setRecurrence(seed.recurrence);
    setCronExpression(seed.cronExpression);
    setDeliveryChannel(seed.deliveryChannel);
    setDeliveryPlatform(seed.deliveryPlatform);
    setDeliveryChatId(seed.deliveryChatId);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || submitPendingRef.current) return;
    submitPendingRef.current = true;
    const input = {
      title: title.trim(),
      note: note.trim(),
      runAt: parsedRunAt,
      recurrence,
      ...(recurrence === 'cron' ? { cronExpression: cronExpression.trim() } : {}),
      delivery,
    };
    setSubmitPending(true);
    try {
      const result = editingId
        ? await props.onUpdate?.(editingId, input)
        : await props.onCreate?.({
          ...input,
          ...(input.note ? { note: input.note } : {}),
        });
      if (result !== false && planReminderMountedRef.current) {
        resetForm();
        props.onOpenChange(false);
      }
    } finally {
      submitPendingRef.current = false;
      if (planReminderMountedRef.current) setSubmitPending(false);
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
        if (!open) closeReminderDialog();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        height="auto"
        header={(
          <DialogHeader
            title={isEditing ? copy.editTitle : copy.createTitle}
            onOpenChange={(open) => {
              if (!open) closeReminderDialog();
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
              id="maka-plan-reminder-form"
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
                  onChange={(value) => setNote(value.slice(0, 1000))}
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
                  isDisabled={formInteractionDisabled}
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
                    question, so choosing 明天 9 点 on a weekly reminder moves
                    the next occurrence without silently making it one-off. */}
                <HStack gap={2} wrap="wrap" role="group" aria-label={copy.presetsAriaLabel}>
                  {copy.presets.map(([preset, label]) => (
                    <UiButton
                      key={preset}
                      variant="secondary"
                      size="sm"
                      label={label}
                      isDisabled={formInteractionDisabled}
                      onClick={() => setRunAtLocal(
                        toPlanReminderLocalDateTimeValue(planReminderPresetRunAt(preset)),
                      )}
                    />
                  ))}
                </HStack>
                <Selector
                  label={copy.field.recurrence}
                  value={recurrence}
                  onChange={(value) => setRecurrence(value as PlanReminderRecurrence)}
                  options={copy.recurrenceOptions.map(([value, label]) => ({ value, label }))}
                  isDisabled={formInteractionDisabled}
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
                  value={deliveryChannel}
                  onChange={(value) => setDeliveryChannel(value as PlanReminderDeliveryTarget['channel'])}
                  options={copy.deliveryOptions.map(([value, label]) => ({ value, label }))}
                  isDisabled={formInteractionDisabled}
                  width="100%"
                />
                {deliveryChannel === 'bot' && (
                  <>
                    <Selector
                      label={copy.field.platform}
                      /* The "why is my platform missing" answer rides the field
                         it answers for, as Selector's own description slot —
                         not a loose paragraph in a third type size. */
                      description={copy.deliveryHelp(formatPlanDeliveryProviderList())}
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
                form="maka-plan-reminder-form"
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
