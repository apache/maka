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

import type { HostContext, TerminalNode, TerminalViewTree } from '../src/host.js';

declare const ctx: HostContext;
const body = ctx.tui.input('note', 'note', 'Note');
const root: TerminalNode = ctx.tui.boundary('review', body, {
  bottom: ctx.tui.row('meta', [ctx.tui.text('hint', 'Ready'), ctx.tui.button('save', 'save')]),
  padding: { horizontal: 1 },
  emphasis: 'accent',
  activity: 'busy',
});
const view: TerminalViewTree = ctx.tui.view({ title: 'Review', revision: 'r1', root });
const version: 8 = view.version;
void version;
// @ts-expect-error Activity is semantic; arbitrary animations are not a public capability.
ctx.tui.boundary('invalid', body, { activity: 'flash' });
// @ts-expect-error Palette colors belong to the terminal kernel.
ctx.tui.boundary('invalid', body, { emphasis: '#ff0000' });
// @ts-expect-error A v6 View cannot declare the v8 contract.
ctx.tui.view({ version: 6, title: 'Old', revision: 'r1', root });
