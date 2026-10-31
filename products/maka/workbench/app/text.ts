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

import { cleanup, signal } from 'nsh';
import { tr, type MessageKey } from './locale';
import { message, type UiText, type UiTextValues } from './text-value';

export { message, type UiText } from './text-value';

export function renderText(value: UiText): string {
  if (typeof value === 'string') return value;
  return tr(
    value.key,
    value.values &&
      Object.fromEntries(
        Object.entries(value.values).map(([key, part]) => [
          key,
          typeof part === 'number' ? part : renderText(part),
        ]),
      ),
  );
}

/** One text owner; its public read tracks both the original value and current locale. */
export function createText() {
  const value = signal<UiText>('');
  const read = () => renderText(value());
  read.set = (text: UiText) => value.set(text);
  return read;
}

/** Brief action feedback; pending states and actionable errors keep their own owners. */
export function createTransientText() {
  const text = createText();
  const set = text.set;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  cleanup(() => {
    alive = false;
    clearTimeout(timer);
  });
  text.set = (value: UiText) => {
    if (!alive) return;
    clearTimeout(timer);
    set(value);
    if (value !== '') timer = setTimeout(() => set(''), 4000);
  };
  return text;
}

export class UiError extends Error {
  readonly text: UiText;
  constructor(key: MessageKey, values?: UiTextValues) {
    const text = message(key, values);
    super(renderText(text));
    this.text = text;
  }
}

export function errorText(reason: unknown): UiText {
  if (reason instanceof UiError) return reason.text;
  const detail = reason instanceof Error ? reason.message : String(reason);
  switch (detail) {
    case 'agent_store_unavailable':
      return message('Conversation data is temporarily unavailable. Try reconnecting.');
    case 'agent_catalog_unavailable':
      return message('Conversation list is temporarily unavailable. Try reconnecting.');
    case 'database connection closed before accepting the operation':
      return message('Connection interrupted. Reconnect to continue; your draft is kept.');
    default:
      return detail;
  }
}
