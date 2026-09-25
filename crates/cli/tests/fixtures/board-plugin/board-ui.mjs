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

/** @typedef {'todo' | 'doing' | 'done'} Column */
/** @typedef {{id: string, title: string, column: Column, note: string}} Card */
/** @typedef {{revision: number | null, cards: Card[], activity: import('../../../../../packages/plugin-sdk/src/host.js').TranscriptResource | null}} Model */

/** @type {import('../../../../../packages/plugin-sdk/src/host.js').TerminalPageFactory<Model>} */
export default ({ tui }) => {
  const columns = /** @type {const} */ (['todo', 'doing', 'done']);
  /** @type {Record<Column, [string, string, string]>} */
  const titles = {
    todo: ['To do', '待办', '待辦'],
    doing: ['Doing', '进行中', '進行中'],
    done: ['Done', '完成', '完成'],
  };
  return {
    async read(route, cx) {
      const model = await cx.backend();
      if (model.activity) {
        return {
          title: cx.t('Board activity', '看板活动', '看板活動'),
          revision: 'activity',
          root: tui.column('root', [
            tui.text(
              'intro',
              cx.t('Live board activity and history', '看板实时活动与历史', '看板即時活動與歷史'),
              'muted',
            ),
            tui.transcript('activity', model.activity),
          ]),
        };
      }
      const { revision, cards } = model;
      const stamp = String(revision ?? 0);
      const card =
        route &&
        typeof route === 'object' &&
        'card' in route &&
        cards.find((item) => item.id === route.card);
      if (card) {
        const index = columns.indexOf(card.column);
        const actions = [
          tui.action('save', cx.t('Save', '保存', '儲存'), { fields: ['title', 'note'] }),
          tui.action('delete', cx.t('Delete', '删除', '刪除'), {
            confirm: {
              title: cx.t('Delete this card?', '删除这张卡片？', '刪除這張卡片？'),
              message: cx.t(
                'It leaves the board for good.',
                '它会从看板上永久移除。',
                '它會從看板上永久移除。',
              ),
              destructive: true,
            },
          }),
        ];
        const buttons = [tui.button('save', 'save', 'primary')];
        if (index > 0) {
          actions.push(tui.action('left', cx.t('Move back', '后退一列', '後退一欄')));
          buttons.push(tui.button('left', 'left'));
        }
        if (index < 2) {
          actions.push(tui.action('right', cx.t('Move on', '前进一列', '前進一欄')));
          buttons.push(tui.button('right', 'right'));
        }
        buttons.push(tui.button('delete', 'delete', 'destructive'));
        return {
          title: card.title,
          revision: stamp,
          fields: [tui.line('title', card.title, 200), tui.area('note', card.note, 4000)],
          actions,
          root: tui.column('root', [
            tui.text('column', cx.t(...titles[card.column]), 'accent'),
            tui.stack('form', [
              tui.input('title', 'title', cx.t('Title', '标题', '標題')),
              tui.input('note', 'note', cx.t('Note', '备注', '備註')),
            ]),
            tui.row('controls', buttons),
          ]),
        };
      }
      const lanes = columns.map((column) =>
        tui.column(
          column,
          [
            tui.spans('title', [
              [cx.t(...titles[column]), 'strong'],
              [`  ${cards.filter((item) => item.column === column).length}`, 'subtle'],
            ]),
            ...cards
              .filter((item) => item.column === column)
              .map((item) =>
                tui.link(
                  `card-${item.id}`,
                  item.title,
                  { card: item.id },
                  item.note ? { detail: item.note } : {},
                ),
              ),
          ],
          0,
        ),
      );
      return {
        title: cx.t('Board', '看板', '看板'),
        revision: stamp,
        fields: [tui.line('new', '', 200, { placeholder: cx.t('A new card', '新卡片', '新卡片') })],
        actions: [tui.action('add', cx.t('Add', '添加', '新增'), { fields: ['new'] })],
        root: tui.column('root', [
          tui.row('lanes', lanes),
          tui.rule('divider'),
          tui.row('adding', [
            tui.input('new', 'new', cx.t('Card', '卡片', '卡片')),
            tui.button('add', 'add', 'primary'),
          ]),
          tui.link('activity', cx.t('Board activity', '看板活动', '看板活動'), {
            activity: true,
          }),
        ]),
      };
    },
    submit: (_submission, cx) => cx.backend(),
  };
};
