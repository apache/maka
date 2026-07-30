/**
 * Plan-reminder create/edit form dialog (issue #1044).
 *
 * Owns ALL form state + the submit pipeline that used to live inline in
 * `plan-reminder-panel.tsx`: the nine field states, editingId, the
 * submitPending single-flight owner, validation, and the close guard. The
 * panel keeps only list/runs/query state and opens this dialog with a
 * `PlanReminderFormSeed` (remounting per open via `key`, so fields always
 * initialize from the seed — same outcome as the old open-handler setters).
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
  planReminderFormValidationMessage,
  planReminderPresetRunAt,
  planReminderTemplateSeed,
  toPlanReminderDateTimeInputValue,
} from './plan-reminder-helpers.js';
import { PlanReminderSelect } from './plan-reminder-select.js';
import {
  Button as UiButton,
  DialogClose,
  DialogContent,
  DialogRoot,
} from './ui.js';
import { Input } from './primitives/input.js';
import { Textarea as UiTextarea } from './primitives/textarea.js';
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from './primitives/menu.js';
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
  const titleRef = useRef<HTMLInputElement>(null);
  const parsedRunAt = Date.parse(runAtLocal);
  const delivery: PlanReminderDeliveryTarget = deliveryChannel === 'bot'
    ? { channel: 'bot', platform: deliveryPlatform, chatId: deliveryChatId.trim() }
    : { channel: 'local' };
  const validationMessage = planReminderFormValidationMessage({
    title,
    parsedRunAt,
    recurrence,
    cronExpression,
    delivery,
    now: Date.now(),
  }, locale);
  const canCreate = validationMessage === null;
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
    setRunAtLocal(toPlanReminderDateTimeInputValue(Date.now() + 60 * 60 * 1000));
    setEditingId(null);
  }

  function closeReminderDialog() {
    if (submitPendingRef.current) return;
    props.onOpenChange(false);
    resetForm();
  }

  function applyRunAtPreset(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday') {
    setRunAtLocal(toPlanReminderDateTimeInputValue(planReminderPresetRunAt(preset)));
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
    <DialogRoot
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          props.onOpenChange(true);
        } else {
          closeReminderDialog();
        }
      }}
    >
      <DialogContent
        className="maka-plan-dialog w-[min(92vw,680px)] p-0"
        aria-labelledby="maka-plan-dialog-title"
        initialFocus={titleRef}
        showClose={false}
      >
        <form className="maka-plan-form" onSubmit={submit} aria-busy={submitPending ? 'true' : undefined}>
          <header className="maka-plan-form-header">
            <div>
              <p className="maka-plan-eyebrow">{copy.eyebrow}</p>
              <h3 id="maka-plan-dialog-title" className="maka-plan-form-title">{isEditing ? copy.editTitle : copy.createTitle}</h3>
            </div>
            <div className="maka-plan-form-header-actions">
              {!isEditing && (
                <Menu>
                  <MenuTrigger
                    render={<UiButton variant="quiet" size="sm" />}
                    disabled={formInteractionDisabled}
                    aria-label={copy.useTemplate}
                  >
                    {copy.useTemplate}
                  </MenuTrigger>
                  <MenuPopup className="min-w-[240px]" align="end" aria-label={copy.templatesAriaLabel}>
                    {templates.map((template) => (
                      <MenuItem key={template.id} onClick={() => applyTemplate(template)}>
                        <span>{template.title}</span>
                        <span className="ml-auto text-muted-foreground">{template.scheduleLabel}</span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}
              <DialogClose
                render={<UiButton variant="quiet" size="icon-sm" />}
                type="button"
                onClick={closeReminderDialog}
                disabled={formInteractionDisabled}
                aria-label={copy.close}
              >
                <X size={16} aria-hidden="true" />
              </DialogClose>
            </div>
          </header>
          <div className="maka-plan-form-grid">
            <label className="maka-plan-field">
              <span>{copy.field.title}</span>
              <Input
                ref={titleRef}
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                maxLength={120}
                data-maka-plan-title-input="true"
                placeholder={copy.titlePlaceholder}
                disabled={formInteractionDisabled}
              />
            </label>
            <label className="maka-plan-field">
              <span>{copy.field.time}</span>
              <Input
                value={runAtLocal}
                onChange={(event) => setRunAtLocal(event.currentTarget.value)}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder="2026-06-05 13:44"
                aria-label={copy.timeAriaLabel}
                disabled={formInteractionDisabled}
              />
            </label>
          </div>
          <div className="maka-plan-presets" aria-label={copy.presetsAriaLabel}>
            {copy.presets.map(([preset, label]) => (
              <UiButton
                key={preset}
                type="button"
                variant="secondary"
                size="sm"
                className="maka-plan-preset"
                onClick={() => applyRunAtPreset(preset)}
                disabled={formInteractionDisabled}
              >
                {label}
              </UiButton>
            ))}
          </div>
          <div className="maka-plan-form-grid">
            <label className="maka-plan-field">
              <span>{copy.field.recurrence}</span>
              <PlanReminderSelect
                value={recurrence}
                onChange={(value) => setRecurrence(value)}
                disabled={formInteractionDisabled}
                ariaLabel={copy.field.recurrence}
                options={copy.recurrenceOptions}
              />
            </label>
            <label className="maka-plan-field">
              <span>{copy.field.delivery}</span>
              <PlanReminderSelect
                value={deliveryChannel}
                onChange={(value) => setDeliveryChannel(value)}
                disabled={formInteractionDisabled}
                ariaLabel={copy.field.delivery}
                options={copy.deliveryOptions}
              />
            </label>
          </div>
          {recurrence === 'cron' && (
            <label className="maka-plan-field">
              <span>Cron</span>
              <Input
                value={cronExpression}
                onChange={(event) => setCronExpression(event.currentTarget.value)}
                maxLength={80}
                placeholder={copy.cronPlaceholder}
                disabled={formInteractionDisabled}
              />
            </label>
          )}
          {deliveryChannel === 'bot' && (
            <>
              <div className="maka-plan-delivery-grid">
                <label className="maka-plan-field">
                  <span>{copy.field.platform}</span>
                  <PlanReminderSelect
                    value={deliveryPlatform}
                    onChange={(value) => setDeliveryPlatform(value)}
                    disabled={formInteractionDisabled}
                    ariaLabel={copy.field.platform}
                    options={BOT_DELIVERY_PROVIDERS.map((provider) => {
                      const icon = (
                        <BotBrandLogo
                          provider={provider}
                          width="100%"
                          height="100%"
                          aria-hidden="true"
                        />
                      );
                      return [provider, botDisplayLabel(provider), icon] as const;
                    })}
                  />
                </label>
                <label className="maka-plan-field">
                  <span>Chat ID</span>
                  <Input
                    value={deliveryChatId}
                    onChange={(event) => setDeliveryChatId(event.currentTarget.value)}
                    maxLength={160}
                    placeholder={copy.chatIdPlaceholder}
                    disabled={formInteractionDisabled}
                  />
                </label>
              </div>
              <p className="maka-plan-delivery-help">
                {copy.deliveryHelp(formatPlanDeliveryProviderList())}
              </p>
            </>
          )}
          <label className="maka-plan-field maka-plan-prompt-field">
            <span>{copy.field.note}</span>
            <UiTextarea
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
              maxLength={1000}
              rows={5}
              placeholder={copy.notePlaceholder}
              disabled={formInteractionDisabled}
            />
          </label>
          {validationMessage && (
            <p className="maka-plan-validation" role="status" aria-live="polite">
              {validationMessage}
            </p>
          )}
          <footer className="maka-plan-form-footer">
            <UiButton
              variant="secondary"
              type="button"
              onClick={closeReminderDialog}
              disabled={formInteractionDisabled}
            >
              {copy.cancel}
            </UiButton>
            <UiButton type="submit" disabled={submitDisabled}>
              {isEditing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              <span>{submitPending ? (isEditing ? copy.saving : copy.creating) : (isEditing ? copy.save : copy.create)}</span>
            </UiButton>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
