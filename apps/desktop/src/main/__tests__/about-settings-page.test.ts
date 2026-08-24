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
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { AboutSettingsPage } from '../../renderer/settings/about-settings-page.js';

test('keeps manual diagnostics available while About metadata is pending', () => {
  const page = createElement(AboutSettingsPage, {});
  const withToasts = createElement(ToastProvider, { children: page });
  const withAstryxLocale = createElement(AstryxLocaleProvider, { children: withToasts });
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: withAstryxLocale }),
  );

  assert.match(markup, />Copy diagnostics</);
  assert.match(markup, /role="status"[^>]*aria-busy="true"/);
});
