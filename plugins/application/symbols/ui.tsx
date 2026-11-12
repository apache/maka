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

import { effect, Clipboard, computed, type JSX } from 'nsh';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { search } from '../../shared/quick-search';
import { symbols } from './symbols';

const KEYWORDS = ['sym', 'symbol', '符号', '符號'];

function Symbols(props: { input: QuickToolInput }) {
  const { input } = props;
  const items = computed(() =>
    search(symbols, input.query(), KEYWORDS, ([, terms]) => [terms]).map(
      ({ item: [character, terms], match }): QuickItem => ({
        id: character,
        title: character,
        detail: terms,
        icon: 'symbol',
        source: tr('Symbol'),
        action: tr('Copy and close'),
        match,
        remembered: true,
        run: () => void Clipboard.writeText(character).then(input.close, input.report),
      }),
    ),
  );
  input.attach({
    items,
    entries: () => [{ id: 'symbols', title: tr('Symbols'), icon: 'symbol', keywords: KEYWORDS }],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) => (
          <Symbols input={input} />
        ),
      },
    },
  };
};
