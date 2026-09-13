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
  Editor,
  Key,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import type { FormRequestEvent } from '@maka/core/events';
import {
  isInteractionFormFieldValueValid,
  type InteractionFormField,
  type InteractionFormResponse,
  type InteractionFormValue,
} from '@maka/core/interaction';
import { sanitizeUnicodeText } from '@maka/core/text-sanitize';
import {
  defineUiMessageCatalog,
  formatUiMessage,
  resolveUiMessageCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { ansi, editorTheme, stripAnsi } from './tui-ansi.js';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';

export interface TuiFormDraft {
  readonly included: boolean;
  readonly value: string | boolean | readonly string[];
}

interface TuiFormCopy {
  readonly requestedBy: string;
  readonly sensitiveWarning: string;
  readonly required: string;
  readonly optional: string;
  readonly omitted: string;
  readonly empty: string;
  readonly invalid: string;
  readonly minimumLength: string;
  readonly maximumLength: string;
  readonly lengthRange: string;
  readonly minimumValue: string;
  readonly maximumValue: string;
  readonly valueRange: string;
  readonly minimumItems: string;
  readonly maximumItems: string;
  readonly itemRange: string;
  readonly format: string;
  readonly reviewHint: string;
  readonly textHint: string;
  readonly choiceHint: string;
  readonly multiHint: string;
  readonly trueValue: string;
  readonly falseValue: string;
  readonly selectedCount: string;
}

const FORM_COPY = resolveUiMessageCatalog(
  defineUiMessageCatalog<TuiFormCopy>()(TUI_COPY_RESOURCES['form-interaction']),
);

const FORM_REVIEW_MAX_VISIBLE_FIELDS = 8;
const FORM_CHOICE_MAX_VISIBLE_OPTIONS = 10;

type EditMode =
  | { readonly kind: 'review' }
  | { readonly kind: 'text'; readonly index: number }
  | { readonly kind: 'choice'; readonly index: number; optionIndex: number }
  | { readonly kind: 'multi'; readonly index: number; optionIndex: number };

export function createTuiFormDrafts(fields: readonly InteractionFormField[]): TuiFormDraft[] {
  return fields.map((field) => {
    const included = field.required || field.default !== undefined;
    if (field.kind === 'boolean') return { included, value: field.default ?? false };
    if (field.kind === 'multi_select') return { included, value: [...(field.default ?? [])] };
    if (field.kind === 'number' || field.kind === 'integer') {
      return { included, value: field.default === undefined ? '' : String(field.default) };
    }
    return { included, value: field.default ?? '' };
  });
}

export function buildTuiFormResponse(
  request: FormRequestEvent,
  drafts: readonly TuiFormDraft[],
): InteractionFormResponse | null {
  if (drafts.length !== request.fields.length) return null;
  const entries: Array<[string, InteractionFormValue]> = [];
  for (const [index, field] of request.fields.entries()) {
    const draft = drafts[index];
    if (!draft) return null;
    if (!draft.included) {
      if (field.required) return null;
      continue;
    }
    const value = draftValue(field, draft);
    if (!isInteractionFormFieldValueValid(field, value)) return null;
    entries.push([field.name, value]);
  }
  return {
    requestId: request.requestId,
    action: 'accept',
    values: Object.fromEntries(entries),
  };
}

export class FormInteractionOverlay implements Component {
  readonly #copy: TuiFormCopy;
  readonly #editor: Editor;
  #drafts: TuiFormDraft[];
  #activeIndex = 0;
  #mode: EditMode = { kind: 'review' };
  #invalid = new Set<number>();
  #submitting = false;

  constructor(
    tui: TUI,
    private readonly input: {
      readonly locale: UiLocale;
      readonly request: FormRequestEvent;
      readonly initialDrafts?: readonly TuiFormDraft[];
      readonly onRespond: (response: InteractionFormResponse) => void;
    },
  ) {
    this.#copy = FORM_COPY[input.locale];
    this.#drafts =
      input.initialDrafts?.length === input.request.fields.length
        ? cloneTuiFormDrafts(input.initialDrafts)
        : createTuiFormDrafts(input.request.fields);
    this.#editor = new Editor(tui, editorTheme(), { paddingX: 0 });
    this.#editor.onChange = (value) => {
      if (this.#mode.kind !== 'text') return;
      this.#replaceDraft(this.#mode.index, { value });
    };
  }

  invalidate(): void {
    this.#editor.invalidate();
  }

  setSubmissionFailed(): void {
    this.#submitting = false;
  }

  snapshotDrafts(): readonly TuiFormDraft[] {
    return cloneTuiFormDrafts(this.#drafts);
  }

  handleInput(data: string): void {
    if (this.#submitting) return;
    if (this.#mode.kind === 'review') {
      this.#handleReviewInput(data);
    } else if (this.#mode.kind === 'text') {
      if (matchesKey(data, Key.escape)) {
        this.#mode = { kind: 'review' };
      } else if (
        (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) &&
        !isKeyRepeat(data)
      ) {
        this.#replaceDraft(this.#mode.index, { value: this.#editor.getText() });
        this.#mode = { kind: 'review' };
      } else {
        this.#editor.handleInput(data);
      }
    } else if (this.#mode.kind === 'choice') {
      this.#handleChoiceInput(data, this.#mode);
    } else {
      this.#handleMultiInput(data, this.#mode);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.#renderHeader(safeWidth);
    if (this.#mode.kind === 'review') lines.push(...this.#renderReview(safeWidth));
    else if (this.#mode.kind === 'text')
      lines.push(...this.#renderTextEditor(this.#mode.index, safeWidth));
    else if (this.#mode.kind === 'choice') lines.push(...this.#renderChoice(this.#mode, safeWidth));
    else lines.push(...this.#renderMulti(this.#mode, safeWidth));
    lines.push(padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth));
    return lines;
  }

  #handleReviewInput(data: string): void {
    const fields = this.input.request.fields;
    if (matchesKey(data, Key.escape)) {
      this.#respond({ requestId: this.input.request.requestId, action: 'cancel' });
      return;
    }
    if (data === 'd' || data === 'D') {
      this.#respond({ requestId: this.input.request.requestId, action: 'decline' });
      return;
    }
    if (data === 's' || data === 'S') {
      this.#submit();
      return;
    }
    if (fields.length === 0) return;
    if (matchesKey(data, Key.up)) {
      this.#activeIndex = this.#activeIndex === 0 ? fields.length - 1 : this.#activeIndex - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#activeIndex = this.#activeIndex === fields.length - 1 ? 0 : this.#activeIndex + 1;
      return;
    }
    const field = fields[this.#activeIndex];
    const draft = this.#drafts[this.#activeIndex];
    if (!field || !draft) return;
    if (matchesKey(data, Key.space) && !field.required) {
      this.#replaceDraft(this.#activeIndex, { included: !draft.included });
      return;
    }
    if ((matchesKey(data, Key.enter) || matchesKey(data, Key.return)) && !isKeyRepeat(data)) {
      if (!draft.included) this.#replaceDraft(this.#activeIndex, { included: true });
      this.#openEditor(field, this.#activeIndex);
    }
  }

  #handleChoiceInput(data: string, mode: Extract<EditMode, { kind: 'choice' }>): void {
    if (matchesKey(data, Key.escape)) {
      this.#mode = { kind: 'review' };
      return;
    }
    const field = this.input.request.fields[mode.index];
    if (!field || (field.kind !== 'boolean' && field.kind !== 'single_select')) return;
    const count = field.kind === 'boolean' ? 2 : field.options.length;
    if (count === 0) return;
    if (matchesKey(data, Key.up))
      mode.optionIndex = mode.optionIndex === 0 ? count - 1 : mode.optionIndex - 1;
    else if (matchesKey(data, Key.down))
      mode.optionIndex = mode.optionIndex === count - 1 ? 0 : mode.optionIndex + 1;
    else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.return)) && !isKeyRepeat(data)) {
      const value =
        field.kind === 'boolean' ? mode.optionIndex === 0 : field.options[mode.optionIndex]?.value;
      if (value !== undefined) this.#replaceDraft(mode.index, { included: true, value });
      this.#mode = { kind: 'review' };
    }
  }

  #handleMultiInput(data: string, mode: Extract<EditMode, { kind: 'multi' }>): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return)
    ) {
      if (!isKeyRepeat(data)) this.#mode = { kind: 'review' };
      return;
    }
    const field = this.input.request.fields[mode.index];
    const draft = this.#drafts[mode.index];
    if (!field || field.kind !== 'multi_select' || !draft || !Array.isArray(draft.value)) return;
    if (field.options.length === 0) return;
    if (matchesKey(data, Key.up))
      mode.optionIndex = mode.optionIndex === 0 ? field.options.length - 1 : mode.optionIndex - 1;
    else if (matchesKey(data, Key.down))
      mode.optionIndex = mode.optionIndex === field.options.length - 1 ? 0 : mode.optionIndex + 1;
    else if (matchesKey(data, Key.space)) {
      const value = field.options[mode.optionIndex]?.value;
      if (value === undefined) return;
      const selected = draft.value.includes(value)
        ? draft.value.filter((candidate) => candidate !== value)
        : [...draft.value, value];
      this.#replaceDraft(mode.index, { included: true, value: selected });
    }
  }

  #openEditor(field: InteractionFormField, index: number): void {
    const draft = this.#drafts[index];
    if (!draft) return;
    if (field.kind === 'boolean') {
      this.#mode = { kind: 'choice', index, optionIndex: draft.value === true ? 0 : 1 };
    } else if (field.kind === 'single_select') {
      this.#mode = {
        kind: 'choice',
        index,
        optionIndex: Math.max(
          0,
          field.options.findIndex((option) => option.value === draft.value),
        ),
      };
    } else if (field.kind === 'multi_select') {
      this.#mode = { kind: 'multi', index, optionIndex: 0 };
    } else {
      this.#editor.setText(typeof draft.value === 'string' ? draft.value : '');
      this.#mode = { kind: 'text', index };
    }
  }

  #submit(): void {
    const response = buildTuiFormResponse(this.input.request, this.#drafts);
    if (response) {
      this.#respond(response);
      return;
    }
    this.#invalid = new Set(
      this.input.request.fields.flatMap((field, index) => {
        const draft = this.#drafts[index];
        if (!draft || (!draft.included && field.required)) return [index];
        if (!draft.included) return [];
        return isInteractionFormFieldValueValid(field, draftValue(field, draft)) ? [] : [index];
      }),
    );
    const first = this.#invalid.values().next().value;
    if (typeof first === 'number') this.#activeIndex = first;
  }

  #respond(response: InteractionFormResponse): void {
    this.#submitting = true;
    this.input.onRespond(response);
  }

  #replaceDraft(index: number, patch: Partial<TuiFormDraft>): void {
    const current = this.#drafts[index];
    if (!current) return;
    this.#drafts = this.#drafts.map((draft, candidate) =>
      candidate === index ? { ...current, ...patch } : draft,
    );
    this.#invalid.delete(index);
  }

  #renderHeader(width: number): string[] {
    const requester = this.input.request.requester;
    const detail = requester.source
      ? `${safeDisplay(requester.name)} · ${safeDisplay(requester.source)}`
      : safeDisplay(requester.name);
    const provenance = formatUiMessage(this.#copy.requestedBy, { detail }, this.input.locale);
    return [
      padLine(ansi.bold(safeDisplay(this.input.request.message)), width),
      padLine(ansi.dim(provenance), width),
      padLine(ansi.red(this.#copy.sensitiveWarning), width),
      padLine('', width),
    ];
  }

  #renderReview(width: number): string[] {
    const lines: string[] = [];
    const window = visibleWindow(
      this.input.request.fields.length,
      this.#activeIndex,
      FORM_REVIEW_MAX_VISIBLE_FIELDS,
    );
    if (window.start > 0) lines.push(padLine(ansi.dim(`  … ↑ ${window.start}`), width));
    this.input.request.fields.slice(window.start, window.end).forEach((field, offset) => {
      const index = window.start + offset;
      const draft = this.#drafts[index];
      if (!draft) return;
      const requirement = field.required ? this.#copy.required : this.#copy.optional;
      const prefix = index === this.#activeIndex ? '→ ' : '  ';
      const summary = this.#summary(field, draft);
      const invalid = this.#invalid.has(index);
      const row = `${prefix}${safeDisplay(field.label)} (${requirement}): ${summary}${invalid ? ` · ${this.#copy.invalid}` : ''}`;
      lines.push(
        formatReviewRow(invalid ? ansi.red(row) : row, index === this.#activeIndex, width),
      );
      if (index === this.#activeIndex && field.description) {
        lines.push(padLine(`  ${ansi.dim(safeDisplay(field.description))}`, width));
      }
      if (index === this.#activeIndex) {
        const constraint = this.#constraint(field);
        if (constraint) lines.push(padLine(`  ${ansi.dim(constraint)}`, width));
      }
    });
    if (window.end < this.input.request.fields.length) {
      lines.push(
        padLine(ansi.dim(`  … ↓ ${this.input.request.fields.length - window.end}`), width),
      );
    }
    if (this.input.request.fields.length === 0) lines.push(padLine(ansi.dim('(no fields)'), width));
    lines.push(padLine('', width));
    lines.push(padLine(ansi.dim(this.#copy.reviewHint), width));
    return lines;
  }

  #renderTextEditor(index: number, width: number): string[] {
    const field = this.input.request.fields[index];
    if (!field) return [];
    this.#editor.focused = true;
    return [
      padLine(
        `${safeDisplay(field.label)} (${field.required ? this.#copy.required : this.#copy.optional})`,
        width,
      ),
      ...this.#fieldDetails(field, width),
      ...this.#editor.render(width),
      padLine(ansi.dim(this.#copy.textHint), width),
    ];
  }

  #renderChoice(mode: Extract<EditMode, { kind: 'choice' }>, width: number): string[] {
    const field = this.input.request.fields[mode.index];
    if (!field || (field.kind !== 'boolean' && field.kind !== 'single_select')) return [];
    const options =
      field.kind === 'boolean'
        ? [this.#copy.trueValue, this.#copy.falseValue]
        : field.options.map((option) => safeDisplay(option.label));
    const window = visibleWindow(options.length, mode.optionIndex, FORM_CHOICE_MAX_VISIBLE_OPTIONS);
    return [
      padLine(safeDisplay(field.label), width),
      ...this.#fieldDetails(field, width),
      ...(window.start > 0 ? [padLine(ansi.dim(`  … ↑ ${window.start}`), width)] : []),
      ...options.slice(window.start, window.end).map((label, offset) => {
        const index = window.start + offset;
        return formatReviewRow(
          `${index === mode.optionIndex ? '→ ' : '  '}${label}`,
          index === mode.optionIndex,
          width,
        );
      }),
      ...(window.end < options.length
        ? [padLine(ansi.dim(`  … ↓ ${options.length - window.end}`), width)]
        : []),
      padLine(ansi.dim(this.#copy.choiceHint), width),
    ];
  }

  #renderMulti(mode: Extract<EditMode, { kind: 'multi' }>, width: number): string[] {
    const field = this.input.request.fields[mode.index];
    const draft = this.#drafts[mode.index];
    if (!field || field.kind !== 'multi_select' || !draft || !Array.isArray(draft.value)) return [];
    const selected = draft.value;
    const window = visibleWindow(
      field.options.length,
      mode.optionIndex,
      FORM_CHOICE_MAX_VISIBLE_OPTIONS,
    );
    return [
      padLine(safeDisplay(field.label), width),
      ...this.#fieldDetails(field, width),
      ...(window.start > 0 ? [padLine(ansi.dim(`  … ↑ ${window.start}`), width)] : []),
      ...field.options.slice(window.start, window.end).map((option, offset) => {
        const index = window.start + offset;
        const row = `${index === mode.optionIndex ? '→ ' : '  '}[${selected.includes(option.value) ? 'x' : ' '}] ${safeDisplay(option.label)}`;
        return formatReviewRow(row, index === mode.optionIndex, width);
      }),
      ...(window.end < field.options.length
        ? [padLine(ansi.dim(`  … ↓ ${field.options.length - window.end}`), width)]
        : []),
      padLine(ansi.dim(this.#copy.multiHint), width),
    ];
  }

  #summary(field: InteractionFormField, draft: TuiFormDraft): string {
    if (!draft.included) return ansi.dim(this.#copy.omitted);
    if (field.kind === 'boolean')
      return draft.value === true ? this.#copy.trueValue : this.#copy.falseValue;
    if (field.kind === 'single_select') {
      const option = field.options.find((candidate) => candidate.value === draft.value);
      return option ? safeDisplay(option.label) : ansi.dim(this.#copy.empty);
    }
    if (field.kind === 'multi_select' && Array.isArray(draft.value)) {
      return formatUiMessage(
        this.#copy.selectedCount,
        { count: draft.value.length },
        this.input.locale,
      );
    }
    return typeof draft.value === 'string' && draft.value.length > 0
      ? safeDisplay(draft.value)
      : ansi.dim(this.#copy.empty);
  }

  #fieldDetails(field: InteractionFormField, width: number): string[] {
    const details = field.description ? [safeDisplay(field.description)] : [];
    const constraint = this.#constraint(field);
    if (constraint) details.push(constraint);
    return details.map((detail) => padLine(ansi.dim(detail), width));
  }

  #constraint(field: InteractionFormField): string | undefined {
    const constraints: string[] = [];
    if (field.kind === 'string') {
      if (field.minLength !== undefined && field.maxLength !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.lengthRange,
            {
              minimum: field.minLength,
              maximum: field.maxLength,
            },
            this.input.locale,
          ),
        );
      } else if (field.minLength !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.minimumLength,
            {
              minimum: field.minLength,
            },
            this.input.locale,
          ),
        );
      } else if (field.maxLength !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.maximumLength,
            {
              maximum: field.maxLength,
            },
            this.input.locale,
          ),
        );
      }
      if (field.format !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.format,
            {
              format: field.format,
            },
            this.input.locale,
          ),
        );
      }
    } else if (field.kind === 'number' || field.kind === 'integer') {
      if (field.minimum !== undefined && field.maximum !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.valueRange,
            {
              minimum: field.minimum,
              maximum: field.maximum,
            },
            this.input.locale,
          ),
        );
      } else if (field.minimum !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.minimumValue,
            {
              minimum: field.minimum,
            },
            this.input.locale,
          ),
        );
      } else if (field.maximum !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.maximumValue,
            {
              maximum: field.maximum,
            },
            this.input.locale,
          ),
        );
      }
    } else if (field.kind === 'multi_select') {
      if (field.minItems !== undefined && field.maxItems !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.itemRange,
            {
              minimum: field.minItems,
              maximum: field.maxItems,
            },
            this.input.locale,
          ),
        );
      } else if (field.minItems !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.minimumItems,
            {
              minimum: field.minItems,
            },
            this.input.locale,
          ),
        );
      } else if (field.maxItems !== undefined) {
        constraints.push(
          formatUiMessage(
            this.#copy.maximumItems,
            {
              maximum: field.maxItems,
            },
            this.input.locale,
          ),
        );
      }
    }
    return constraints.length === 0 ? undefined : constraints.join(' · ');
  }
}

function cloneTuiFormDrafts(drafts: readonly TuiFormDraft[]): TuiFormDraft[] {
  return drafts.map((draft) => ({
    included: draft.included,
    value: Array.isArray(draft.value) ? [...draft.value] : draft.value,
  }));
}

function draftValue(field: InteractionFormField, draft: TuiFormDraft): InteractionFormValue {
  if (field.kind === 'number' || field.kind === 'integer') {
    return typeof draft.value === 'string' && draft.value.trim() !== ''
      ? Number(draft.value)
      : Number.NaN;
  }
  return draft.value;
}

function safeDisplay(value: string): string {
  return sanitizeUnicodeText(stripAnsi(value), { maxCodePoints: 1_024 });
}

function formatReviewRow(text: string, active: boolean, width: number): string {
  const padded = padLine(text, width);
  return active ? ansi.reverse(padded) : padded;
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}

function visibleWindow(
  length: number,
  activeIndex: number,
  limit: number,
): {
  readonly start: number;
  readonly end: number;
} {
  if (length <= limit) return { start: 0, end: length };
  const start = Math.min(
    Math.max(0, activeIndex - Math.floor(limit / 2)),
    Math.max(0, length - limit),
  );
  return { start, end: Math.min(length, start + limit) };
}
