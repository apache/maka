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

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslator } from '@astryxdesign/core/i18n';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { LocaleProvider } from '../locale-context.js';

function TranslationProbe() {
  const translate = useTranslator();
  return createElement(
    'span',
    null,
    `${translate('@maka.test.outer')}|${translate('@maka.test.inner')}`,
  );
}

test('nested Astryx locale providers preserve ambient scoped overrides', () => {
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        overrides: { '@maka.test.outer': 'Outer copy' },
        children: createElement(AstryxLocaleProvider, {
          overrides: { '@maka.test.inner': 'Inner copy' },
          children: createElement(TranslationProbe),
        }),
      }),
    }),
  );

  assert.match(markup, />Outer copy\|Inner copy</);
});
