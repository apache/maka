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

export type BrowserCopy = {
  unsupportedScheme: string;
  invalidUrl: string;
  openFailed: string;
  navigationFailed: string;
  navigationFailedDetail: string;
  loadFailed: string;
  retry: string;
  retryAria: string;
  retryDetail: string;
  loadFailureDns: string;
  loadFailureOffline: string;
  loadFailureTimeout: string;
  loadFailureCertificate: string;
  loadFailureSecureConnection: string;
  loadFailureBlocked: string;
  loadFailureNetwork: string;
  panelAria: string;
  panelAriaWithTitle: (title: string) => string;
  insecure: string;
  backAria: string;
  back: string;
  forwardAria: string;
  forward: string;
  stopAria: string;
  refreshAria: string;
  stop: string;
  refresh: string;
  addressAria: string;
  addressPlaceholder: string;
  closeAria: string;
  close: string;
  focusPreview: string;
  releaseToFocus: string;
  restorePreview: string;
  title: string;
  description: string;
};

const BROWSER_COPY = {
  'zh-CN': {
    unsupportedScheme: '嵌入式浏览器只支持打开 HTTP/HTTPS 网页地址。',
    invalidUrl: '这个地址无法识别，请检查网址后重试。',
    openFailed: '无法打开地址',
    navigationFailed: '浏览器导航失败',
    navigationFailedDetail: '页面暂时无法打开，请稍后重试。',
    loadFailed: '页面加载失败',
    retry: '重试',
    retryAria: '重试加载页面',
    retryDetail: '重试会重新打开此地址，不会重新提交表单数据或发送原始来源信息。',
    loadFailureDns: '找不到这个网站，请检查网址或网络连接后重试。',
    loadFailureOffline: '网络连接已断开，请连接网络后重试。',
    loadFailureTimeout: '连接网站超时，请稍后重试。',
    loadFailureCertificate: '网站的安全证书无法验证，请检查网址或联系网站管理员。',
    loadFailureSecureConnection: '无法与此网站建立安全连接，请联系网站管理员。',
    loadFailureBlocked: '页面请求被浏览器或网站的安全规则拦截，请联系网站管理员。',
    loadFailureNetwork: '暂时无法连接到这个页面，请检查网络连接或稍后重试。',
    panelAria: '嵌入式浏览器',
    panelAriaWithTitle: (title) => `嵌入式浏览器：${title}`,
    insecure: '这个站点用 HTTP 传输，连接未加密。',
    backAria: '浏览器后退',
    back: '后退',
    forwardAria: '浏览器前进',
    forward: '前进',
    stopAria: '停止加载页面',
    refreshAria: '刷新页面',
    stop: '停止',
    refresh: '刷新',
    addressAria: '浏览器地址',
    addressPlaceholder: '输入网址并回车',
    closeAria: '关闭浏览器页面',
    close: '关闭页面',
    focusPreview: '聚焦网页',
    releaseToFocus: '松开以聚焦网页',
    restorePreview: '还原分栏',
    title: '嵌入式浏览器',
    description: '输入网址打开页面，或让助手帮你导航并操作。',
  },
  'zh-TW': {
    unsupportedScheme: '嵌入式瀏覽器只支援開啟 HTTP/HTTPS 網頁地址。',
    invalidUrl: '這個地址無法識別，請檢查網址後重試。',
    openFailed: '無法開啟地址',
    navigationFailed: '瀏覽器導航失敗',
    navigationFailedDetail: '頁面暫時無法開啟，請稍後重試。',
    loadFailed: '頁面載入失敗',
    retry: '重試',
    retryAria: '重試載入頁面',
    retryDetail: '重試會重新開啟此地址，不會重新提交表單資料或傳送原始來源資訊。',
    loadFailureDns: '找不到這個網站，請檢查網址或網路連線後重試。',
    loadFailureOffline: '網路連線已中斷，請連接網路後重試。',
    loadFailureTimeout: '連接網站逾時，請稍後重試。',
    loadFailureCertificate: '無法驗證網站的安全憑證，請檢查網址或聯絡網站管理員。',
    loadFailureSecureConnection: '無法與此網站建立安全連線，請聯絡網站管理員。',
    loadFailureBlocked: '頁面請求遭瀏覽器或網站的安全規則封鎖，請聯絡網站管理員。',
    loadFailureNetwork: '暫時無法連接到這個頁面，請檢查網路連線或稍後重試。',
    panelAria: '嵌入式瀏覽器',
    panelAriaWithTitle: (title) => `嵌入式瀏覽器：${title}`,
    insecure: '這個站點用 HTTP 傳輸，連線未加密。',
    backAria: '瀏覽器後退',
    back: '後退',
    forwardAria: '瀏覽器前進',
    forward: '前進',
    stopAria: '停止載入頁面',
    refreshAria: '重新整理頁面',
    stop: '停止',
    refresh: '重新整理',
    addressAria: '瀏覽器地址',
    addressPlaceholder: '輸入網址並回車',
    closeAria: '關閉瀏覽器頁面',
    close: '關閉頁面',
    focusPreview: '聚焦網頁',
    releaseToFocus: '放開以聚焦網頁',
    restorePreview: '還原分欄',
    title: '嵌入式瀏覽器',
    description: '輸入網址開啟頁面，或讓助手幫你導航並操作。',
  },
  en: {
    unsupportedScheme: 'The embedded browser only supports HTTP and HTTPS addresses.',
    invalidUrl: 'This address is not valid. Check it and try again.',
    openFailed: 'Could not open address',
    navigationFailed: 'Browser navigation failed',
    navigationFailedDetail: 'The page could not be opened. Try again later.',
    loadFailed: 'Page failed to load',
    retry: 'Retry',
    retryAria: 'Retry loading page',
    retryDetail: 'Retry reopens the address without resubmitting form data or sending the original referrer.',
    loadFailureDns: 'This website could not be found. Check the address or your connection and retry.',
    loadFailureOffline: 'You are offline. Connect to the internet and retry.',
    loadFailureTimeout: 'The connection timed out. Try again later.',
    loadFailureCertificate: 'The website’s certificate could not be verified. Check the address or contact the site owner.',
    loadFailureSecureConnection: 'A secure connection to this website could not be established. Contact the site owner.',
    loadFailureBlocked: 'The page request was blocked by browser or website security rules. Contact the site owner.',
    loadFailureNetwork: 'The page could not be reached. Check your connection or try again later.',
    panelAria: 'Embedded browser',
    panelAriaWithTitle: (title) => `Embedded browser: ${title}`,
    insecure: 'This site is served over HTTP, so the connection is not encrypted.',
    backAria: 'Go back in browser',
    back: 'Back',
    forwardAria: 'Go forward in browser',
    forward: 'Forward',
    stopAria: 'Stop loading page',
    refreshAria: 'Reload page',
    stop: 'Stop',
    refresh: 'Reload',
    addressAria: 'Browser address',
    addressPlaceholder: 'Enter an address and press Enter',
    closeAria: 'Close browser page',
    close: 'Close page',
    focusPreview: 'Focus webpage',
    releaseToFocus: 'Release to focus webpage',
    restorePreview: 'Restore split view',
    title: 'Embedded browser',
    description: 'Enter an address, or ask the assistant to navigate and interact with a page.',
  },
} satisfies UiCatalog<BrowserCopy>;

export function getBrowserCopy(locale: UiLocale): BrowserCopy {
  return BROWSER_COPY[locale];
}
