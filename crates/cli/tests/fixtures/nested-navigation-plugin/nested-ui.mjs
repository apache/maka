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
  async read(route, cx) {
    const model = await cx.backend();
    const { context, note } = model;
    return {
      title: 'Nested notes',
      revision: String(model.revision ?? 0),
      fields: [tui.line('note', note, 200)],
      actions: [tui.action('save', 'Save nested note', { fields: ['note'] })],
      root: tui.column('root', [
        tui.text('stored', `Stored: ${note}`),
        tui.input(
          'note',
          'note',
          route.pane === 'details' ? 'Detail note draft' : 'Base note draft',
        ),
        tui.button('save', 'save', 'primary'),
        ...(route.pane === 'details'
          ? []
          : [tui.link('details', 'Note details', { context, pane: 'details' })]),
      ]),
    };
  },
  submit: (_submission, cx) => cx.backend(),
});
