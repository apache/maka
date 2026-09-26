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

(() => {
  const pick = (locale, en, zhCN, zhTW) => {
    const language = String(locale ?? '').toLowerCase();
    if (language === 'zh-tw' || language === 'zh-hant') return zhTW ?? zhCN ?? en;
    if (language.startsWith('zh')) return zhCN ?? en;
    return en;
  };
  const view = ({ title, revision, fields = [], actions = [], root }) => ({
    version: 8,
    title,
    revision: String(revision),
    fields,
    actions,
    root,
  });
  const item = (key, title, target, extra = {}) => ({
    kind: 'item',
    key,
    title,
    target,
    ...extra,
  });
  const text = (key, value, tone = 'normal') => ({
    kind: 'text',
    key,
    spans: [{ text: String(value), tone }],
  });
  const builders = Object.freeze({
    collection: (key, options) => ({ kind: 'collection', key, ...options }),
    transcript: (key, resource) => ({ kind: 'transcript', key, resource }),
    view,
    column: (key, children, gap = 1) => ({ kind: 'column', key, gap, children }),
    stack: (key, children) => ({ kind: 'column', key, gap: 0, children }),
    row: (key, children, gap = 2) => ({ kind: 'row', key, gap, children }),
    boundary: (key, body, { bottom, padding, emphasis = 'normal', activity = 'idle' } = {}) => ({
      kind: 'boundary',
      key,
      body,
      ...(bottom === undefined ? {} : { bottom }),
      padding: { horizontal: 0, vertical: 0, ...padding },
      emphasis,
      activity,
    }),
    text,
    spans: (key, spans) => ({
      kind: 'text',
      key,
      spans: spans.map(([value, tone = 'normal']) => ({ text: String(value), tone })),
    }),
    heading: (key, value) => text(key, value, 'strong'),
    rule: (key) => ({ kind: 'rule', key }),
    scroll: (key, rows, child) => ({ kind: 'scroll', key, rows, child }),
    split: (key, ratio, left, right) => ({ kind: 'split', key, ratio, left, right }),
    tabs: (key, current, tabs) => ({ kind: 'tabs', key, current, tabs }),
    link: (key, title, route, extra) => item(key, title, { kind: 'route', route }, extra),
    act: (key, title, action, extra) => item(key, title, { kind: 'action', action }, extra),
    open: (key, title, session, extra) => item(key, title, { kind: 'session', session }, extra),
    button: (key, action, role = 'normal', label) => ({
      kind: 'button',
      key,
      action,
      role,
      ...(label === undefined ? {} : { label }),
    }),
    input: (key, field, label = '') => ({ kind: 'input', key, field, label }),
    progress: (key, value, max, label = '') => ({ kind: 'progress', key, value, max, label }),
    markdown: (key, value) => ({ kind: 'markdown', key, text: String(value) }),
    code: (key, value) => ({ kind: 'code', key, text: String(value) }),
    slot: (key, name, context = null) => ({ kind: 'slot', key, name, context }),
    action: (id, label, extra = {}) => ({ id, label, ...extra }),
    toggle: (id, value) => ({ id, control: { kind: 'toggle', value: Boolean(value) } }),
    line: (id, value = '', maxBytes = 256, extra = {}) => ({
      id,
      control: { kind: 'text', value: String(value), max_bytes: maxBytes, ...extra },
    }),
    area: (id, value = '', maxBytes = 8192, extra = {}) => ({
      id,
      control: {
        kind: 'text',
        value: String(value),
        max_bytes: maxBytes,
        multiline: true,
        ...extra,
      },
    }),
    choice: (id, value, options) => ({
      id,
      control: {
        kind: 'choice',
        value,
        options: options.map(([option, label]) => ({ value: option, label })),
      },
    }),
  });
  return Object.freeze({ pick, builders });
})();
