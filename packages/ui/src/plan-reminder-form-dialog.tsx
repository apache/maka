/**
 * Plan-reminder create/edit form dialog (issue #1044).
 *
 * Owns ALL form state + the submit pipeline that used to live inline in
 * `plan-reminder-panel.tsx`: the nine field states, editingId, the
 * submitPending single-flight owner, validation, and the close guard. The
 * panel keeps only list/runs/query state and opens this dialog with a
 * `PlanReminderFormSeed`. It remounts the closed form session before opening,
 * so Astryx always observes a false-to-true transition.
 *
 * Async-owner invariants (pinned by plan-reminder-panel-contract):
 *   - submit rejects re-entry synchronously via submitPendingRef before
 *     React commits the disabled state;
 *   - the dialog refuses to close while a submit is in flight;
 *   - the pending owner is released on unmount without writing React state.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { Check, Plus, X } from './icons.js';
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
  FormLayout,
  Selector,
  TextInput,
} from '@astryxdesign/core';
import { IconButton } from '@astryxdesign/core';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { TextArea as UiTextarea } from '@astryxdesign/core';
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
  }

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    props.onOpenChange(false);
    resetForm();
  }

  function applyRunAtPreset(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday') {
    setRunAtLocal(toPlanReminderLocalDateTimeValue(planReminderPresetRunAt(preset)));
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

  return (
    <Dialog
      isOpen={props.open}
      onOpenChange={(open) => {
        if (open) {
          props.onOpenChange(true);
        } else {
          closeReminderDialog();
        }
      }}
      className="maka-plan-dialog"
      width={680}
      maxHeight="min(86dvh, 760px)"
      aria-labelledby="maka-plan-dialog-title"
      padding={0}
      purpose="form"
    >
      <Layout
        content={
          <LayoutContent padding={0}>
        <form className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
          <header className="maka-plan-form-header">
            <div>
              <p className="maka-plan-eyebrow">{copy.eyebrow}</p>
              <h3 id="maka-plan-dialog-title" className="maka-plan-form-title">{isEditing ? copy.editTitle : copy.createTitle}</h3>
            </div>
            <div className="maka-plan-form-header-actions">
              {!isEditing && (
                <DropdownMenu
                  button={{
                    label: copy.useTemplate,
                    variant: 'ghost',
                    size: 'sm',
                    isDisabled: formInteractionDisabled,
                  }}
                  menuWidth={240}
                  className="maka-plan-template-menu"
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
              )}
              <IconButton
                onClick={closeReminderDialog}
                isDisabled={formInteractionDisabled}
                label={copy.close}
                icon={<X size={16} aria-hidden="true" />}
                variant="ghost"
                size="sm"
              />
            </div>
          </header>
          <FormLayout direction="horizontal">
            <TextInput
              hasAutoFocus
              label={copy.field.title}
              value={title}
              onChange={(value) => setTitle(value.slice(0, 120))}
              data-maka-plan-title-input="true"
              placeholder={copy.titlePlaceholder}
              isDisabled={formInteractionDisabled}
              isRequired
              status={validation?.field === 'title'
                ? { type: 'error', message: validation.message }
                : undefined}
            />
            <TextInput
              label={copy.field.time}
              value={runAtLocal}
              onChange={setRunAtLocal}
              placeholder={copy.timePlaceholder}
              isDisabled={formInteractionDisabled}
              isRequired
              status={validation?.field === 'time'
                ? { type: 'error', message: validation.message }
                : undefined}
            />
          </FormLayout>
          <div className="maka-plan-presets" aria-label={copy.presetsAriaLabel}>
            {copy.presets.map(([preset, label]) => (
              <UiButton
                key={preset}
                variant="secondary"
                size="sm"
                className="maka-plan-preset"
                onClick={() => applyRunAtPreset(preset)}
                isDisabled={formInteractionDisabled}
                label={label}
              />
            ))}
          </div>
          <FormLayout direction="horizontal">
            <Selector
              value={recurrence}
              onChange={(value) => setRecurrence(value as PlanReminderRecurrence)}
              isDisabled={formInteractionDisabled}
              label={copy.field.recurrence}
              width="100%"
              options={copy.recurrenceOptions.map(([value, label]) => ({ value, label }))}
            />
            <Selector
              value={deliveryChannel}
              onChange={(value) => setDeliveryChannel(value as PlanReminderDeliveryTarget['channel'])}
              isDisabled={formInteractionDisabled}
              label={copy.field.delivery}
              width="100%"
              options={copy.deliveryOptions.map(([value, label]) => ({ value, label }))}
            />
          </FormLayout>
          {recurrence === 'cron' && (
            <TextInput
              label={copy.field.cron}
              value={cronExpression}
              onChange={(value) => setCronExpression(value.slice(0, 80))}
              placeholder={copy.cronPlaceholder}
              isDisabled={formInteractionDisabled}
              isRequired
              status={validation?.field === 'cron'
                ? { type: 'error', message: validation.message }
                : undefined}
            />
          )}
          {deliveryChannel === 'bot' && (
            <>
              <FormLayout direction="horizontal">
                <Selector
                  value={deliveryPlatform}
                  onChange={(value) => setDeliveryPlatform(value as BotProvider)}
                  isDisabled={formInteractionDisabled}
                  label={copy.field.platform}
                  width="100%"
                  options={BOT_DELIVERY_PROVIDERS.map((provider) => {
                    const icon = (
                      <BotBrandLogo
                        provider={provider}
                        width="100%"
                        height="100%"
                        aria-hidden="true"
                      />
                    );
                    return {
                      value: provider,
                      label: botDisplayLabel(provider),
                      icon,
                    };
                  })}
                />
                <TextInput
                  label={copy.field.chatId}
                  value={deliveryChatId}
                  onChange={(value) => setDeliveryChatId(value.slice(0, 160))}
                  placeholder={copy.chatIdPlaceholder}
                  isDisabled={formInteractionDisabled}
                  isRequired
                  status={validation?.field === 'chatId'
                    ? { type: 'error', message: validation.message }
                    : undefined}
                />
              </FormLayout>
              <p className="maka-plan-delivery-help">
                {copy.deliveryHelp(formatPlanDeliveryProviderList())}
              </p>
            </>
          )}
          <UiTextarea
            label={copy.field.note}
            value={note}
            onChange={(value) => setNote(value.slice(0, 1000))}
            maxLength={1000}
            rows={5}
            placeholder={copy.notePlaceholder}
            isDisabled={formInteractionDisabled}
          />
          <footer className="maka-plan-form-footer">
            <UiButton
              variant="secondary"
              onClick={closeReminderDialog}
              isDisabled={formInteractionDisabled}
              label={copy.cancel}
            />
            <UiButton
              variant="primary"
              type="submit"
              isDisabled={submitDisabled}
              icon={isEditing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              label={submitPending ? (isEditing ? copy.saving : copy.creating) : (isEditing ? copy.save : copy.create)}
            />
          </footer>
        </form>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
