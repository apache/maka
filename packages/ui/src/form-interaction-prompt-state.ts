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
  isInteractionFormFieldValueValid,
  type InteractionFormField,
  type InteractionFormResponse,
  type InteractionFormValue,
} from '@maka/core/interaction';
import type { FormRequestEvent } from '@maka/core/events';

export interface InteractionFormFieldDraft {
  /** Optional fields need an explicit presence bit so omitted and false/empty stay distinct. */
  readonly included: boolean;
  readonly value: string | boolean | readonly string[];
}

export function createInteractionFormDrafts(
  fields: readonly InteractionFormField[],
): InteractionFormFieldDraft[] {
  return fields.map((field) => ({
    included: field.required || field.default !== undefined,
    value: initialDraftValue(field),
  }));
}

export function interactionFormFieldDraftIsValid(
  field: InteractionFormField,
  draft: InteractionFormFieldDraft,
): boolean {
  if (!draft.included) return !field.required;
  const value = interactionFormDraftValue(field, draft);
  return value !== undefined && isInteractionFormFieldValueValid(field, value);
}

export function buildInteractionFormResponse(
  request: FormRequestEvent,
  drafts: readonly InteractionFormFieldDraft[],
): InteractionFormResponse | null {
  const entries: Array<[string, InteractionFormValue]> = [];
  for (const [index, field] of request.fields.entries()) {
    const draft = drafts[index];
    if (!draft || !interactionFormFieldDraftIsValid(field, draft)) return null;
    if (!draft.included) continue;
    const value = interactionFormDraftValue(field, draft);
    if (value === undefined) return null;
    entries.push([field.name, value]);
  }
  return { requestId: request.requestId, action: 'accept', values: Object.fromEntries(entries) };
}

function initialDraftValue(field: InteractionFormField): InteractionFormFieldDraft['value'] {
  if (field.default !== undefined) {
    if (field.kind === 'number' || field.kind === 'integer') return String(field.default);
    return field.default;
  }
  if (field.kind === 'boolean') return false;
  if (field.kind === 'multi_select') return [];
  return '';
}

function interactionFormDraftValue(
  field: InteractionFormField,
  draft: InteractionFormFieldDraft,
): InteractionFormValue | undefined {
  if (field.kind === 'number' || field.kind === 'integer') {
    if (typeof draft.value !== 'string' || draft.value.trim().length === 0) return undefined;
    const value = Number(draft.value);
    return Number.isFinite(value) ? value : undefined;
  }
  if (field.kind === 'boolean') return typeof draft.value === 'boolean' ? draft.value : undefined;
  if (field.kind === 'multi_select') return Array.isArray(draft.value) ? draft.value : undefined;
  return typeof draft.value === 'string' ? draft.value : undefined;
}
