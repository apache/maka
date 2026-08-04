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
import { Check, X } from './icons.js';
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
  Field,
  TextInput,
} from '@astryxdesign/core';
import type { ISODateTimeString } from '@astryxdesign/core/DateTimeInput';
import { IconButton } from '@astryxdesign/core';
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

/** The reference panels render enum values as quiet "value ⌄" menu triggers,
 *  not bordered select boxes. Ghost DropdownMenu with the current option as
 *  its label; the row label travels in the trigger's aria-label. */
function PlanValueMenu(props: {
  fieldLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; icon?: React.ReactNode }>;
  disabled?: boolean;
  onSelect(value: string): void;
}) {
  const current = props.options.find((option) => option.value === props.value)?.label ?? props.value;
  return (
    <DropdownMenu
      button={{
        label: current,
        variant: 'ghost',
        size: 'sm',
        isDisabled: props.disabled,
        'aria-label': `${props.fieldLabel}: ${current}`,
      }}
      menuWidth={220}
    >
      {props.options.map((option) => (
        <DropdownMenuItem
          key={option.value}
          label={option.label}
          icon={option.icon}
          onClick={() => props.onSelect(option.value)}
          endContent={option.value === props.value ? <Check size={14} aria-hidden="true" /> : undefined}
        />
      ))}
    </DropdownMenu>
  );
}

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

  // Split-view panel (no <dialog>): own the focus contract the Dialog used
  // to provide. On open, capture the opener (the panel has already re-focused
  // the triggering row control by layout-effect time) and move focus to the
  // title; on close, hand focus back to the opener — the e2e asserts the row
  // menu regains focus after Escape.
  const planFormOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.open) return undefined;
    planFormOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.getElementById('maka-plan-title')?.focus();
    return () => {
      const opener = planFormOpenerRef.current;
      planFormOpenerRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [props.open]);

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

  if (!props.open) return null;

  // Split-view panel (reference layout): the form is an in-page column flush
  // against the task list — not an overlay. Non-modal `role="dialog"` keeps
  // the e2e/assistive name; Escape closes via the same guarded path.
  return (
    <aside
      className="maka-plan-form-aside"
      role="dialog"
      aria-labelledby="maka-plan-dialog-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeReminderDialog();
        }
      }}
    >
            <div className="maka-plan-form-header">
              <h3 id="maka-plan-dialog-title" className="maka-plan-form-kicker">{isEditing ? copy.editTitle : copy.createTitle}</h3>
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
            </div>
        {/* Redesign (WAWQAQ msg `67d21f99`): the form reads like the reference
            scheduled-task panels now — a quiet kicker, a large borderless
            title, a bare description field, then label-left / control-right
            hairline rows in two labeled groups. All state, validation and
            submit invariants are unchanged; only the presentation moved. */}
        <form id="maka-plan-reminder-form" className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
          <Field
            label={copy.field.title}
            inputID="maka-plan-title"
            isLabelHidden
            isRequired
            isDisabled={formInteractionDisabled}
            status={titleTouched && validation?.field === 'title'
              ? { type: 'error', message: validation.message }
              : undefined}
            statusVariant="detached"
          >
            {/* Raw input inside Field: the Field contract generates the ids but
                injects nothing — describedby / invalid / required and the
                Dialog's data-autofocus hook (raw autoFocus fires before
                showModal() and silently loses) are wired here by hand. */}
            <input
              id="maka-plan-title"
              className="maka-plan-title-input"
              value={title}
              data-autofocus="true"
              aria-required="true"
              aria-invalid={titleTouched && validation?.field === 'title' ? 'true' : undefined}
              aria-describedby={titleTouched && validation?.field === 'title' ? 'maka-plan-title-status' : undefined}
              onChange={(event) => {
                setTitleTouched(true);
                setTitle(event.target.value.slice(0, 120));
              }}
              placeholder={copy.titlePlaceholder}
              disabled={formInteractionDisabled}
              data-maka-plan-title-input="true"
            />
          </Field>
          <UiTextarea
            label={copy.field.note}
            isLabelHidden
            value={note}
            onChange={(value) => setNote(value.slice(0, 1000))}
            rows={3}
            placeholder={copy.notePlaceholder}
            isDisabled={formInteractionDisabled}
          />
          <section className="maka-plan-group" aria-label={copy.groupSchedule}>
            <p className="maka-plan-group-label">{copy.groupSchedule}</p>
            <div className="maka-plan-rows">
              <div className="maka-plan-row">
                <span className="maka-plan-row-label">{copy.field.recurrence}</span>
                <PlanValueMenu
                  fieldLabel={copy.field.recurrence}
                  value={recurrence}
                  disabled={formInteractionDisabled}
                  options={copy.recurrenceOptions.map(([value, label]) => ({ value, label }))}
                  onSelect={(value) => setRecurrence(value as PlanReminderRecurrence)}
                />
              </div>
              <div className="maka-plan-row">
                <span className="maka-plan-row-label">{copy.field.at}</span>
                <DateTimeInput
                  label={copy.field.at}
                  isLabelHidden
                  value={(runAtLocal || undefined) as ISODateTimeString | undefined}
                  onChange={(value) => setRunAtLocal(value ?? '')}
                  isDisabled={formInteractionDisabled}
                  isRequired
                  size="sm"
                  hourFormat="24h"
                  timeIncrement={5}
                  width="100%"
                  status={validation?.field === 'time'
                    ? { type: 'error', message: validation.message }
                    : undefined}
                />
              </div>
              {recurrence === 'cron' && (
                <div className="maka-plan-row">
                  <span className="maka-plan-row-label">{copy.field.cron}</span>
                  <TextInput
                    label={copy.field.cron}
                    isLabelHidden
                    value={cronExpression}
                    onChange={(value) => setCronExpression(value.slice(0, 80))}
                    placeholder={copy.cronPlaceholder}
                    isDisabled={formInteractionDisabled}
                    isRequired
                    width={220}
                    status={validation?.field === 'cron'
                      ? { type: 'error', message: validation.message }
                      : undefined}
                  />
                </div>
              )}
              <div className="maka-plan-presets" role="group" aria-label={copy.presetsAriaLabel}>
                {copy.presets.map(([preset, label]) => (
                  <UiButton
                    key={preset}
                    variant="ghost"
                    size="sm"
                    className="maka-plan-preset"
                    onClick={() => applyRunAtPreset(preset)}
                    isDisabled={formInteractionDisabled}
                    label={label}
                  />
                ))}
              </div>
            </div>
          </section>
          <section className="maka-plan-group" aria-label={copy.groupDelivery}>
            <p className="maka-plan-group-label">{copy.groupDelivery}</p>
            <div className="maka-plan-rows">
              <div className="maka-plan-row">
                <span className="maka-plan-row-label">{copy.field.channel}</span>
                <PlanValueMenu
                  fieldLabel={copy.field.channel}
                  value={deliveryChannel}
                  disabled={formInteractionDisabled}
                  options={copy.deliveryOptions.map(([value, label]) => ({ value, label }))}
                  onSelect={(value) => setDeliveryChannel(value as PlanReminderDeliveryTarget['channel'])}
                />
              </div>
              {deliveryChannel === 'bot' && (
                <>
                  <div className="maka-plan-row">
                    <span className="maka-plan-row-label">{copy.field.platform}</span>
                    <PlanValueMenu
                      fieldLabel={copy.field.platform}
                      value={deliveryPlatform}
                      disabled={formInteractionDisabled}
                      options={BOT_DELIVERY_PROVIDERS.map((provider) => ({
                        value: provider,
                        label: botDisplayLabel(provider),
                        icon: (
                          <BotBrandLogo
                            provider={provider}
                            width={16}
                            height={16}
                            aria-hidden="true"
                          />
                        ),
                      }))}
                      onSelect={(value) => setDeliveryPlatform(value as BotProvider)}
                    />
                  </div>
                  <div className="maka-plan-row">
                    <span className="maka-plan-row-label">{copy.field.chatId}</span>
                    <TextInput
                      label={copy.field.chatId}
                      isLabelHidden
                      value={deliveryChatId}
                      onChange={(value) => setDeliveryChatId(value.slice(0, 160))}
                      placeholder={copy.chatIdPlaceholder}
                      isDisabled={formInteractionDisabled}
                      isRequired
                      width={220}
                      status={validation?.field === 'chatId'
                        ? { type: 'error', message: validation.message }
                        : undefined}
                    />
                  </div>
                </>
              )}
            </div>
            {deliveryChannel === 'bot' && (
              <p className="maka-plan-delivery-help">
                {copy.deliveryHelp(formatPlanDeliveryProviderList())}
              </p>
            )}
          </section>
        </form>
        <div className="maka-plan-form-footer">
          <UiButton
            variant="primary"
            type="submit"
            form="maka-plan-reminder-form"
            isDisabled={submitDisabled}
            label={submitPending ? (isEditing ? copy.saving : copy.creating) : (isEditing ? copy.save : copy.create)}
          />
        </div>
    </aside>
  );
}
