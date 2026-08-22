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

import { generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import { redactSecrets } from '@maka/ui';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';

export function settingsActionErrorMessage(error: unknown, locale: UiLocale = 'zh'): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const classified = locale === 'zh' ? generalizedErrorMessageChinese(new Error(raw), '') : '';
  if (classified) return classified;
  const redacted = redactSecrets(raw).trim();
  if (locale === 'zh' && redacted && /[\u4E00-\u9FFF]/.test(redacted)) return redacted;
  return getSettingsSharedCopy(locale).unknownError;
}
