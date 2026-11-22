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

import { message as uiMessage, type UiText } from './text-value.ts';
import type {
  FormField,
  FormValue,
  InteractionAnswer,
  InteractionRequest,
} from '../../../../packages/plugin-sdk/src/generated/runtime';

export type FormRequest = Extract<InteractionRequest, { kind: 'form' }>;
export type FormDraft = {
  included: boolean;
  value: string | boolean | string[] | undefined;
  hidden: boolean;
};

export const utf8Bytes = (text: string) => {
  let bytes = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};
export function initialForm(fields: FormField[]): FormDraft[] {
  return fields.map((field) => {
    const supplied = field.default !== undefined && field.default !== null;
    return {
      included: field.required || supplied,
      value:
        field.kind === 'number' || field.kind === 'integer'
          ? supplied
            ? String(field.default)
            : ''
          : supplied
            ? (field.default as string | boolean | string[])
            : field.kind === 'string'
              ? ''
              : field.kind === 'multi_select'
                ? []
                : undefined,
      hidden: false,
    };
  });
}
function calendar(value: string, time: boolean): boolean {
  const match = value.match(
    time
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
      : /^(\d{4})-(\d{2})-(\d{2})$/,
  );
  if (!match) return false;
  const n = (index: number) => Number(match[index] ?? 0);
  const year = n(1),
    month = n(2),
    day = n(3);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    (!time || (n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(7) <= 23 && n(8) <= 59))
  );
}
function problem(field: FormField, value: FormValue | undefined): UiText | null {
  switch (field.kind) {
    case 'string': {
      if (typeof value !== 'string') return uiMessage('Enter text.');
      const length = [...value].length;
      if (length < (field.minLength ?? 0))
        return uiMessage('Use at least {count} characters.', { count: field.minLength! });
      if (field.maxLength !== undefined && field.maxLength !== null && length > field.maxLength)
        return uiMessage('Use at most {count} characters.', { count: field.maxLength! });
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        return uiMessage('Enter an email address.');
      if (field.format === 'uri') {
        try {
          new URL(value);
        } catch {
          return uiMessage('Enter a complete URI, including its scheme.');
        }
      }
      if (
        (field.format === 'date' || field.format === 'date-time') &&
        !calendar(value, field.format === 'date-time')
      )
        return field.format === 'date'
          ? uiMessage('Enter a valid date: YYYY-MM-DD.')
          : uiMessage('Enter a valid date and time, including seconds and a timezone.');
      return null;
    }
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.kind === 'integer' && !Number.isSafeInteger(value))
      )
        return field.kind === 'integer'
          ? uiMessage('Enter a whole, safe integer.')
          : uiMessage('Enter a finite number.');
      if (value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity))
        return uiMessage('Use a number from {minimum} to {maximum}.', {
          minimum: field.minimum ?? '−∞',
          maximum: field.maximum ?? '∞',
        });
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : uiMessage('Choose Yes or No.');
    case 'single_select':
      return typeof value === 'string' && field.options.some((option) => option.value === value)
        ? null
        : uiMessage('Choose one option.');
    case 'multi_select':
      return Array.isArray(value) &&
        value.length >= (field.minItems ?? 0) &&
        value.length <= (field.maxItems ?? field.options.length) &&
        new Set(value).size === value.length &&
        value.every((part) => field.options.some((option) => option.value === part))
        ? null
        : uiMessage('Choose {minimum}–{maximum} options.', {
            minimum: field.minItems ?? 0,
            maximum: field.maxItems ?? field.options.length,
          });
  }
}
export function formSubmission(
  fields: FormField[],
  drafts: FormDraft[],
): {
  answer: Extract<InteractionAnswer, { kind: 'form'; action: 'accept' }> | null;
  problems: Array<UiText | null>;
} {
  const values: Record<string, FormValue> = Object.create(null);
  const problems = fields.map((field, index) => {
    const draft = drafts[index];
    if (!draft || (!draft.included && field.required)) return uiMessage('This field is required.');
    if (!draft.included) return null;
    const raw = draft.value;
    const value =
      field.kind === 'number' || field.kind === 'integer'
        ? typeof raw === 'string' &&
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw.trim())
          ? Number(raw)
          : undefined
        : raw;
    const error = problem(field, value);
    if (!error && value !== undefined) values[field.name] = value;
    return error;
  });
  return {
    answer: problems.some(Boolean) ? null : { kind: 'form', action: 'accept', values },
    problems,
  };
}
