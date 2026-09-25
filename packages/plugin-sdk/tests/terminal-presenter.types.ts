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

import type {
  HostContext,
  TerminalContext,
  TerminalPageFactory,
  TranscriptOpen,
  TranscriptRead,
} from '../src/host.js';

declare const host: HostContext;
const ui: TerminalPageFactory<{ title: string }> = ({ tui }) => ({
  async read(_route, cx) {
    const data = await cx.backend();
    // @ts-expect-error UI contexts have no business caller authority.
    cx.caller.views;
    // @ts-expect-error UI factories cannot register sources.
    tui.transcriptResource('extra');
    return { title: data.title, revision: '1', root: tui.rule('body') };
  },
  submit: (_input, cx) => cx.backend(),
  recover: (_route, cx) => cx.backend(),
});
void ui;
host.tui.app(
  'app',
  {
    entry: 'app-ui.mjs',
    backend: (request, cx) => {
      cx.caller.signal.throwIfAborted();
      return request.kind === 'read' ? { title: 'App' } : { kind: 'applied', route: null };
    },
  },
  { title: { fallback: 'App' }, context: 'application' },
);
declare const cx: TerminalContext;
// @ts-expect-error The backend receives the original request, never a replacement.
cx.backend({ kind: 'submit' });
// @ts-expect-error Inline page handlers are unsupported.
host.tui.app('old', { read() {} }, { title: { fallback: 'Old' }, context: 'application' });
// @ts-expect-error Generic Remote methods cannot publish terminal views.
host.remote.method('old', () => null, { terminalView: { version: 7 } });
const stream = { next: () => ({ done: true as const, value: undefined }), cancel() {}, close() {} };
// @ts-expect-error Generic Remote streams cannot publish terminal views.
host.remote.stream('old', () => stream, { terminalView: { version: 7 } });
// @ts-expect-error Every reader open requires a mount UUID.
const opened: TranscriptOpen = { resource: 'r', route: null, locale: 'en' };
// @ts-expect-error Every page read requires the original mount UUID.
const read: TranscriptRead = { resource: 'r', fence: 0, direction: 'tail' };
void opened;
void read;
