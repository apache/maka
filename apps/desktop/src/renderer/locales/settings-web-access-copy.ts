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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type WebAccessSettingsCopy = {
  loadFailed: string;
  passphraseTitle: string;
  passphraseHelp: string;
  passphraseLabel: string;
  passphraseConfirmLabel: string;
  savePassphrase: string;
  passphraseSaved: string;
  passphraseMismatch: string;
  passphraseTooShort: string;
  passphraseSaveFailed: string;
  authenticatorTitle: string;
  authenticatorHelp: string;
  showQr: string;
  replaceQr: string;
  replaceQrConfirm: string;
  qrAlt: string;
  confirmCodeLabel: string;
  confirmCodePlaceholder: string;
  confirmCode: string;
  confirmOk: string;
  confirmFailed: string;
  enabled: string;
  enabledHelp: string;
  enabledAria: string;
  enableFailed: string;
  notEnrolled: string;
  recoveryTitle: string;
  recoveryHelp: string;
  generateRecovery: string;
  recoveryShownOnce: string;
  recoveryCodesAria: string;
  recoveryFailed: string;
};

const SETTINGS_WEB_ACCESS_COPY = {
  'zh-CN': {
    loadFailed: '载入网页访问设置失败',
    passphraseTitle: '通行口令',
    passphraseHelp: '浏览器客户端用这段口令登录。桌面应用不会在启动时索要。',
    passphraseLabel: '通行口令',
    passphraseConfirmLabel: '确认通行口令',
    savePassphrase: '保存口令',
    passphraseSaved: '已保存通行口令',
    passphraseMismatch: '两次输入不一致。',
    passphraseTooShort: '口令至少 12 个字符。',
    passphraseSaveFailed: '保存通行口令失败',
    authenticatorTitle: '验证器',
    authenticatorHelp: '用身份验证应用扫描二维码，然后输入 6 位验证码确认。',
    showQr: '显示验证器二维码',
    replaceQr: '更换验证器',
    replaceQrConfirm: '更换验证器会生成新密钥。你需要重新扫描二维码并再次启用网页访问。确定继续？',
    qrAlt: '验证器二维码',
    confirmCodeLabel: '6 位验证码',
    confirmCodePlaceholder: '000000',
    confirmCode: '确认验证码',
    confirmOk: '验证器已确认',
    confirmFailed: '验证码不正确。',
    enabled: '启用网页访问',
    enabledHelp: '启用后，浏览器客户端可以用通行口令与验证器登录。桌面应用不会询问这些凭据。',
    enabledAria: '启用网页访问',
    enableFailed: '无法更改网页访问开关',
    notEnrolled: '请先保存口令并确认验证器。',
    recoveryTitle: '恢复码',
    recoveryHelp: '生成 8 组一次性恢复码。只显示一次，请立即保存。',
    generateRecovery: '生成恢复码',
    recoveryShownOnce: '这些恢复码只显示一次，离开此页后无法再查看。',
    recoveryCodesAria: '恢复码',
    recoveryFailed: '生成恢复码失败',
  },
  'zh-TW': {
    loadFailed: '載入網頁存取設定失敗',
    passphraseTitle: '通行口令',
    passphraseHelp: '瀏覽器用戶端用這段口令登入。桌面應用不會在啟動時索要。',
    passphraseLabel: '通行口令',
    passphraseConfirmLabel: '確認通行口令',
    savePassphrase: '儲存口令',
    passphraseSaved: '已儲存通行口令',
    passphraseMismatch: '兩次輸入不一致。',
    passphraseTooShort: '口令至少 12 個字元。',
    passphraseSaveFailed: '儲存通行口令失敗',
    authenticatorTitle: '驗證器',
    authenticatorHelp: '用身份驗證應用掃描 QR 碼，然後輸入 6 位驗證碼確認。',
    showQr: '顯示驗證器 QR 碼',
    replaceQr: '更換驗證器',
    replaceQrConfirm: '更換驗證器會產生新金鑰。你需要重新掃描 QR 碼並再次啟用網頁存取。確定繼續？',
    qrAlt: '驗證器 QR 碼',
    confirmCodeLabel: '6 位驗證碼',
    confirmCodePlaceholder: '000000',
    confirmCode: '確認驗證碼',
    confirmOk: '驗證器已確認',
    confirmFailed: '驗證碼不正確。',
    enabled: '啟用網頁存取',
    enabledHelp: '啟用後，瀏覽器用戶端可以用通行口令與驗證器登入。桌面應用不會詢問這些憑據。',
    enabledAria: '啟用網頁存取',
    enableFailed: '無法更改網頁存取開關',
    notEnrolled: '請先儲存口令並確認驗證器。',
    recoveryTitle: '復原碼',
    recoveryHelp: '產生 8 組一次性復原碼。只顯示一次，請立即保存。',
    generateRecovery: '產生復原碼',
    recoveryShownOnce: '這些復原碼只顯示一次，離開此頁後無法再查看。',
    recoveryCodesAria: '復原碼',
    recoveryFailed: '產生復原碼失敗',
  },
  en: {
    loadFailed: 'Could not load web access settings',
    passphraseTitle: 'Passphrase',
    passphraseHelp: 'The browser client signs in with this passphrase. The desktop app does not ask for it at startup.',
    passphraseLabel: 'Passphrase',
    passphraseConfirmLabel: 'Confirm passphrase',
    savePassphrase: 'Save passphrase',
    passphraseSaved: 'Passphrase saved',
    passphraseMismatch: 'The two passphrases do not match.',
    passphraseTooShort: 'Use at least 12 characters.',
    passphraseSaveFailed: 'Could not save the passphrase',
    authenticatorTitle: 'Authenticator',
    authenticatorHelp: 'Scan the QR code with an authenticator app, then enter the 6-digit code to confirm.',
    showQr: 'Show authenticator QR',
    replaceQr: 'Replace authenticator',
    replaceQrConfirm: 'Replacing the authenticator mints a new secret. You will need to scan a new QR code and re-enable web access. Continue?',
    qrAlt: 'Authenticator QR code',
    confirmCodeLabel: '6-digit code',
    confirmCodePlaceholder: '000000',
    confirmCode: 'Confirm code',
    confirmOk: 'Authenticator confirmed',
    confirmFailed: 'That code is not correct.',
    enabled: 'Enable web access',
    enabledHelp: 'When enabled, the browser client can sign in with the passphrase and authenticator. The desktop app does not ask for these.',
    enabledAria: 'Enable web access',
    enableFailed: 'Could not change web access',
    notEnrolled: 'Save a passphrase and confirm the authenticator first.',
    recoveryTitle: 'Recovery codes',
    recoveryHelp: 'Generate 8 one-time recovery codes. They are shown once — save them now.',
    generateRecovery: 'Generate recovery codes',
    recoveryShownOnce: 'These codes are shown once. You cannot view them again after leaving this page.',
    recoveryCodesAria: 'Recovery codes',
    recoveryFailed: 'Could not generate recovery codes',
  },
} satisfies UiCatalog<WebAccessSettingsCopy>;

export function getWebAccessSettingsCopy(locale: UiLocale): WebAccessSettingsCopy {
  return SETTINGS_WEB_ACCESS_COPY[locale];
}
