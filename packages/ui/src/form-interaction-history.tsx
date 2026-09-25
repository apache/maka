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

import type { FormInteractionMessage } from '@maka/core/session';
import type { UiCatalog } from '@maka/core/ui-locale';
import { useUiLocale } from './locale-context.js';

const historyCopy: UiCatalog<{ selected: string; cancelled: string; declined: string; closed: string; chosen: string; empty: string }> = {
  'zh-CN': { selected: '你选择了', cancelled: '你取消了选择', declined: '你拒绝了请求', closed: '选择已关闭', chosen: '已选', empty: '未填写' },
  'zh-TW': { selected: '你選擇了', cancelled: '你取消了選擇', declined: '你拒絕了請求', closed: '選擇已關閉', chosen: '已選', empty: '未填寫' },
  en: { selected: 'You selected', cancelled: 'You cancelled the selection', declined: 'You declined the request', closed: 'Selection closed', chosen: 'Selected', empty: 'Not provided' },
};

export function FormInteractionHistory({ message }: { message: FormInteractionMessage }) {
  const copy = historyCopy[useUiLocale()];
  const { request, outcome } = message;
  if (request.kind === 'question') {
    const answers = outcome.kind === 'question_answer' ? outcome.answers : [];
    const summary = outcome.kind === 'closure' ? copy.closed : `${copy.selected}: ${answers.filter(Boolean).join(' · ') || copy.empty}`;
    return <details className="maka-form-history" data-interaction-id={message.id}>
      <summary>{summary}</summary>
      <div className="maka-form-history-content">
        {request.questions.map((question, index) => <div key={index} className="maka-form-history-field">
          <p className="maka-form-history-question">{question.question}</p>
          <ul>{question.options.map((option) => <li key={option.label} data-selected={answers[index] === option.label}>
            <span>{option.label}</span>{answers[index] === option.label && <strong> — {copy.chosen}</strong>}
            {option.description && <p>{option.description}</p>}
          </li>)}</ul>
          {answers[index] && !question.options.some((option) => option.label === answers[index]) && <p>{copy.selected}: {answers[index]}</p>}
        </div>)}
      </div>
    </details>;
  }
  if (outcome.kind === 'question_answer') return null;
  const values = outcome.kind === 'form_answer' && outcome.action === 'accept' ? outcome.values : undefined;
  const labels = request.fields.flatMap((field) => {
    const value = values?.[field.name];
    if (value === undefined) return [];
    if (field.kind === 'single_select' || field.kind === 'multi_select')
      return field.options.filter((option) => Array.isArray(value) ? value.includes(option.value) : value === option.value).map((option) => option.label);
    return [String(value)];
  });
  const summary = outcome.kind === 'closure' ? copy.closed : outcome.action === 'cancel' ? copy.cancelled : outcome.action === 'decline' ? copy.declined : `${copy.selected}: ${labels.join(' · ')}`;
  return <details className="maka-form-history" data-interaction-id={message.id}>
    <summary>{summary}</summary>
    <div className="maka-form-history-content">
      <p className="maka-form-history-question">{request.message}</p>
      {request.fields.map((field) => <div key={field.name} className="maka-form-history-field">
        <p>{field.label}</p>
        {field.description && <p>{field.description}</p>}
        {field.kind === 'single_select' || field.kind === 'multi_select' ? <ul>
          {field.options.map((option) => {
            const value = values?.[field.name];
            const selected = Array.isArray(value) ? value.includes(option.value) : value === option.value;
            return <li key={option.value} data-selected={selected}>
              <span>{option.label}</span>{selected && <strong> — {copy.chosen}</strong>}
              {option.description && <p>{option.description}</p>}
            </li>;
          })}
        </ul> : <p>{values?.[field.name] === undefined ? copy.empty : String(values[field.name])}</p>}
      </div>)}
    </div>
  </details>;
}
