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

/** @type {import('../../../../../packages/plugin-sdk/src/host.js').TerminalPageFactory<{resource: import('../../../../../packages/plugin-sdk/src/host.js').TranscriptResource}>} */
export default ({ tui }) => ({
  async read(_route, cx) {
    const model = await cx.backend();
    return {
      title: cx.t('Memory lab', '内存测量', '記憶體測量'),
      revision: '1',
      root: tui.column('root', [
        tui.text(
          'intro',
          cx.t('10,000 source lines', '10,000 源文本行', '10,000 原始文字行'),
          'muted',
        ),
        tui.transcript('reader', model.resource),
      ]),
    };
  },
  submit: (_submission, cx) => cx.backend(),
});
