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

import { Clipboard, computed, type JSX } from 'nsh';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { QuickRows } from '../../../products/maka/workbench/app/QuickBar';
import { tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword, rank } from '../../shared/quick-search';
import { symbols } from './symbols';

const KEYWORDS = ['sym', 'symbol', '符号', '符號'];
const LIMIT = 30;

function Symbols(props: { input: QuickToolInput }) {
  const { input } = props;
  const matches = computed(() => {
    const text = afterKeyword(input.query(), KEYWORDS);
    if (text === null) return [];
    return text === ''
      ? symbols.slice(0, LIMIT)
      : rank(symbols, text, ([, terms]) => [terms], LIMIT);
  });
  return (
    <QuickRows
      input={input}
      items={matches}
      title={([character]) => character}
      hint={() => tr('Copy')}
      activate={([character]) =>
        void Clipboard.writeText(character).then(input.close, input.report)
      }
    />
  );
}

export const activate: UiModule<JSX.Element>['activate'] = () => ({
  exports: {
    tool: {
      kind: 'view',
      contract: quickToolView.id,
      render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) => (
        <Symbols input={input} />
      ),
    },
  },
});
