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
    const note = model.value.note ?? '';
    return {
      title: cx.t('Task notes', '任务备注', '任務備註'),
      revision: String(model.revision ?? 0),
      fields: [tui.line('note', note, 200)],
      actions: [
        tui.action('save', cx.t('Save note', '保存备注', '儲存備註'), { fields: ['note'] }),
      ],
      root: tui.boundary(
        'root',
        tui.stack('fields', [
          tui.text(
            'review',
            model.value.reviewed ? 'Reviewed independently' : 'Not reviewed',
            'subtle',
          ),
          tui.text('saved', `Saved note: ${note}`, 'subtle'),
          tui.input('note', 'note', cx.t('Note draft', '备注草稿', '備註草稿')),
        ]),
        {
          bottom: tui.row('controls', [tui.button('save', 'save', 'primary')]),
          padding: { horizontal: 1, vertical: 0 },
          emphasis: 'accent',
          activity: model.busy ? 'busy' : 'idle',
        },
      ),
    };
  },
  submit: (_submission, cx) => cx.backend(),
});
