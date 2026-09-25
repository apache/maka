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
    const { operation } = model;
    if (model.sameRoute) {
      return {
        title: 'Mutation fault',
        revision: operation,
        root: tui.text('receipt', `Saved same route: ${model.original.submission.fields.note}`),
      };
    }
    if (route?.done) {
      const original = model.original;
      return {
        title: 'Mutation fault',
        revision: route.operation,
        root: tui.text('receipt', `Recovered original: ${original.submission.fields.note}`),
      };
    }
    return {
      title: 'Mutation fault',
      revision: operation,
      fields: [tui.line('note', '', 128)],
      actions: [
        tui.action('ui-same-route-throw', 'Save then UI throw', { fields: ['note'] }),
        tui.action('ui-same-route-runaway', 'Save then UI loop', { fields: ['note'] }),
        tui.action('runaway', 'Commit then fail', {
          fields: ['note'],
          recovery: { operation },
        }),
      ],
      root: tui.column('root', [
        tui.input('note', 'note', 'Original note'),
        tui.button('commit', 'runaway'),
        tui.button('same-throw', 'ui-same-route-throw'),
        tui.button('same-loop', 'ui-same-route-runaway'),
      ]),
    };
  },
  async submit(submission, cx) {
    const receipt = await cx.backend();
    if (submission.action === 'ui-runaway' || submission.action === 'ui-same-route-runaway') {
      while (true) {
        /* The Host already holds the original durable receipt. */
      }
    }
    if (submission.action === 'ui-throw' || submission.action === 'ui-same-route-throw')
      throw new Error('UI failure after durable mutation');
    if (submission.action === 'ui-never-settle') await new Promise(() => {});
    return receipt;
  },
  recover: (_route, cx) => cx.backend(),
});
