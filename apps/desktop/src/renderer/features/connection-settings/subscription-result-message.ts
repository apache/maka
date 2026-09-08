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

import { generalizedErrorMessageForLocale, redactSecrets } from '@maka/core/redaction';
import type { UiLocale } from '@maka/core/ui-locale';

export function subscriptionResultMessage(
  message: string | undefined,
  fallback: string,
  locale: UiLocale = 'zh-CN',
  reason?: string,
): string {
  const raw = redactSecrets(message ?? '').trim();
  // The Host refuses an enrollment this install has not opted into and says so
  // with a typed reason. Read the reason, not the English message: a reworded
  // string or an added locale must not silently disable this branch. The
  // message match stays only as a fallback for callers without a typed reason.
  if (reason === 'experimental_disabled' || /enrollment is disabled for this provider/i.test(raw)) {
    if (locale === 'zh-CN') return '本机未启用该账号登录方式；可改用导入兼容凭据，或由管理员启用后重试。';
    if (locale === 'zh-TW') return '本機未啟用該帳號登入方式；可改用匯入相容憑據，或由管理員啟用後重試。';
    return 'This sign-in is not enabled on this install. Import a compatible credential instead, or ask an operator to enable it.';
  }
  if (!raw) return fallback;
  if (/already in progress|superseded by a new attempt/i.test(raw)) {
    if (locale === 'zh-CN') return '上一轮浏览器登录仍在进行或已切换，请再点一次登录，或稍后再试。';
    if (locale === 'zh-TW') return '上一輪瀏覽器登入仍在進行或已切換，請再按一次登入，或稍後再試。';
    return 'A previous browser login is still running or was superseded. Try logging in again shortly.';
  }
  if (/did not present OAuth|no matching OAuth presentation/i.test(raw)) {
    if (locale === 'zh-CN') return '无法打开系统浏览器完成登录，请检查是否拦截了弹窗后重试。';
    if (locale === 'zh-TW') return '無法開啟系統瀏覽器完成登入，請檢查是否封鎖了彈出式視窗後再試。';
    return 'Could not open the system browser for login. Check popup blockers and try again.';
  }
  const classified = generalizedErrorMessageForLocale(new Error(raw), '', locale);
  if (classified) return classified;
  return locale === 'zh-CN' || !/[\u4e00-\u9fff]/.test(raw) ? raw : fallback;
}
