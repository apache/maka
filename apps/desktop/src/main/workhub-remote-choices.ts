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

import type { InteractionAnswer, InteractionFormValue, InteractionRequest } from '@maka/core/interaction';

type Choice = { label: string; description?: string; value: string };
type Question = { label: string; options: readonly Choice[]; multiple: boolean; name: string; min?: number; max?: number };

function questions(request: InteractionRequest): Question[] | undefined {
  if (request.kind === 'question') return request.questions.map((question, index) => ({
    label: question.question, name: String(index), multiple: false,
    options: question.options.map((option) => ({ ...option, value: option.label })),
  }));
  if (request.kind !== 'form' || request.fields.some((field) => field.kind !== 'single_select' && field.kind !== 'multi_select')) return;
  return request.fields.map((field) => {
    if (field.kind !== 'single_select' && field.kind !== 'multi_select') throw new Error('Unsupported remote field');
    return { label: field.label, name: field.name, options: field.options, multiple: field.kind === 'multi_select',
      ...(field.kind === 'multi_select' ? { min: field.minItems ?? (field.required ? 1 : 0), max: field.maxItems } : {}) };
  });
}

function optionMark(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function isRecentWorkPicker(request: InteractionRequest): boolean {
  return request.kind === 'question' && request.questions.length === 1
    && /^(最近的工作|Recent work)[:：]?$/.test(request.questions[0]!.question.trim());
}

export function formatRemoteChoices(request: InteractionRequest, reference: string): string | undefined {
  const list = questions(request);
  if (!list?.length) return;
  const recentWork = isRecentWorkPicker(request);
  const replyHint = recentWork
    ? '回复选项生成下一步 prompt, 回复 nxt 查看更多工作'
    : list.length === 1
    ? list[0]!.multiple ? '回复字母，可多选，如 AC。' : '回复选项，如 A。'
    : list.some((question) => question.multiple)
      ? '按题顺序回复，用 / 分隔；多选字母连写。'
      : `按题顺序回复，如 ${'A'.repeat(list.length)}。`;
  return [
    `待回答 #${reference}`,
    ...(request.kind === 'form' ? [request.message] : []),
    ...list.map((question, index) => {
      const title = `${list.length > 1 ? `${index + 1}. ` : ''}${question.label}${question.multiple ? '（多选）' : ''}`;
      const options = question.options.map((option, index) => {
        const description = recentWork && /^(取消|Cancel)$/i.test(option.label.trim())
          ? '' : recentWork ? option.description?.replace(/\s*→\s*(?=下一步[:：])/g, '\n') : option.description;
        return `${optionMark(index)}. ${option.label}${description ? `\n${description}` : ''}`;
      }).join('\n\n');
      return `${title}${recentWork ? '\n' : '\n\n'}${options}`;
    }),
    replyHint,
  ].join('\n\n');
}

export type RemoteChoiceAnswer =
  | { kind: 'answer'; answer: InteractionAnswer }
  | { kind: 'invalid'; message: string }
  | { kind: 'text' };

export function parseRemoteChoices(request: InteractionRequest, text: string): RemoteChoiceAnswer {
  const list = questions(request);
  if (!list?.length) return { kind: 'text' };
  const input = text.trim().toUpperCase();
  if (input === 'NXT' && isRecentWorkPicker(request)) {
    return { kind: 'answer', answer: { kind: 'question', answers: ['nxt'] } };
  }
  // Ordinary language remains a WorkHub message. Only compact choice syntax
  // is interpreted here; permission requests are deliberately unsupported.
  if (!/^[A-Z0-9\s/,，、]+$/.test(input)) return { kind: 'text' };
  if (/[A-Z]{5,}/.test(input) && input.length !== list.length) return { kind: 'text' };
  let parts: string[];
  if (input.includes('/')) parts = input.split('/').map((part) => part.trim());
  else if (list.length === 1) parts = [input];
  else if (/\s/.test(input)) parts = input.split(/\s+/);
  else parts = [...input];
  const invalid = (message: string): RemoteChoiceAnswer => ({ kind: 'invalid', message });
  if (parts.length !== list.length) return invalid(`需要按顺序回答 ${list.length} 个问题，请重新发送完整选择。`);
  const values: Record<string, InteractionFormValue> = {};
  const answers: string[] = [];
  for (const [index, question] of list.entries()) {
    const part = parts[index]!;
    const tokens = question.multiple
      ? (/[\s,，、]/.test(part) ? part.split(/[\s,，、]+/).filter(Boolean) : /^\d+$/.test(part) && question.options.length > 9 ? [part] : [...part])
      : [part];
    const indices = tokens.map((token) => /^[A-Z]$/.test(token) ? token.charCodeAt(0) - 65 : /^\d+$/.test(token) ? Number(token) - 1 : -1);
    if (!indices.length || indices.some((i) => i < 0 || i >= question.options.length) || new Set(indices).size !== indices.length)
      return invalid(`第 ${index + 1} 题选项无效，请使用题目列出的字母或数字。`);
    if (question.multiple && (indices.length < (question.min ?? 0) || indices.length > (question.max ?? Infinity)))
      return invalid(`第 ${index + 1} 题选择数量不符合要求。`);
    const selected = indices.map((i) => question.options[i]!.value);
    values[question.name] = question.multiple ? selected : selected[0]!;
    answers.push(selected[0]!);
  }
  return { kind: 'answer', answer: request.kind === 'question'
    ? { kind: 'question', answers }
    : { kind: 'form', action: 'accept', values } };
}
