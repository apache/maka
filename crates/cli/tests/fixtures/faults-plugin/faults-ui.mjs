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

export default ({ tui }) => ({
  async read(_route, cx) {
    const model = await cx.backend();
    const { mode, title } = model;
    // The backend marker proves this bridge was called, not the loop start.
    if (mode === 'await_then_runaway_read') await Promise.resolve();
    if (mode === 'runaway_read' || mode === 'await_then_runaway_read') {
      while (true) {
        /* Only this document's presenter VM is occupied. */
      }
    }
    if (mode === 'never_settle') await new Promise(() => {});
    if (mode === 'cooperative_pending') {
      await cx.signal.wait();
      throw Object.assign(new Error('Acceptance read cancelled'), { code: 'cancelled' });
    }
    const body = {
      title,
      revision: '1',
      fields: [tui.line('draft', '', 128, { placeholder: 'Local draft' })],
      actions: [tui.action('run', 'Run presenter')],
      root: tui.boundary(
        'root',
        tui.column('body', [
          tui.text('retained', 'Last-good acceptance content'),
          tui.input('draft', 'draft', 'Draft'),
          tui.transcript('history', model.history),
        ]),
        {
          bottom: tui.button('run', 'run'),
        },
      ),
    };
    if (mode === 'invalid') body.root = { kind: 'not_a_node', key: 'bad' };
    if (mode === 'duplicate')
      body.root = tui.column('bad', [tui.text('same', 'first'), tui.text('same', 'second')]);
    if (mode === 'oversized') body.root = tui.text('large', 'x'.repeat(80 * 1024));
    return body;
  },
  async submit(submission, cx) {
    const receipt = await cx.backend();
    if (submission.action === 'run') {
      while (true) {
        /* The backend's rejection remains authoritative after this UI fault. */
      }
    }
    return receipt;
  },
});
