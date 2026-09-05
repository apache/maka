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

import type { SettingsTestResult } from '@maka/core/settings';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type SettingsTestResultCopy = {
  proxy: {
    reachable: (
      endpoint: string | undefined,
      location: string | undefined,
    ) => string;
    disabled: string;
    configurationMissing: string;
    credentialMissing: string;
    timeout: string;
    httpError: (status: number | undefined) => string;
    unreachable: string;
  };
  bot: {
    credentialsValid: (username: string | undefined) => string;
    tokenMissing: string;
    tokenInvalid: string;
    appCredentialsMissing: string;
    connectionFailed: string;
  };
};

const COPY = {
  'zh-CN': {
    proxy: {
      reachable: (endpoint, location) =>
        ["代理配置有效", endpoint, location].filter(Boolean).join(" · "),
      disabled: "请先启用代理服务器，再进行测试。",
      configurationMissing: "请填写代理服务器地址和端口后再测试。",
      credentialMissing: "代理认证已开启，请输入代理密码后再测试。",
      timeout: "代理测试超时，请检查代理服务是否可达。",
      httpError: (status) =>
        status === undefined
          ? "代理测试返回了错误响应，请检查代理服务或测试地址。"
          : `代理测试返回 HTTP ${status}，请检查代理服务或测试地址。`,
      unreachable: "代理不可达，请检查服务器地址、端口和认证信息。",
    },
    bot: {
      credentialsValid: (username) =>
        username
          ? `凭据检查已通过 · ${username}。这不代表消息收发服务已启动。`
          : "凭据检查已通过。这不代表消息收发服务已启动。",
      tokenMissing: "请填写 Bot Token 后再测试。",
      tokenInvalid: "Bot Token 无效，请检查后重试。",
      appCredentialsMissing: "请填写 App ID 和 App Secret 后再测试。",
      connectionFailed: "请检查凭据和网络设置后重试。",
    },
  },
  'zh-TW': {
    proxy: {
      reachable: (endpoint, location) =>
        ["代理設定有效", endpoint, location].filter(Boolean).join(" · "),
      disabled: "請先啟用代理伺服器，再進行測試。",
      configurationMissing: "請填寫代理伺服器地址和埠後再測試。",
      credentialMissing: "代理認證已開啟，請輸入代理密碼後再測試。",
      timeout: "代理測試超時，請檢查代理服務是否可達。",
      httpError: (status) =>
        status === undefined
          ? "代理測試回傳了錯誤回應，請檢查代理服務或測試地址。"
          : `代理測試回傳 HTTP ${status}，請檢查代理服務或測試地址。`,
      unreachable: "代理不可達，請檢查伺服器地址、埠和認證資訊。",
    },
    bot: {
      credentialsValid: (username) =>
        username
          ? `憑據檢查已透過 · ${username}。這不代表訊息收發服務已啟動。`
          : "憑據檢查已透過。這不代表訊息收發服務已啟動。",
      tokenMissing: "請填寫 Bot Token 後再測試。",
      tokenInvalid: "Bot Token 無效，請檢查後重試。",
      appCredentialsMissing: "請填寫 App ID 和 App Secret 後再測試。",
      connectionFailed: "請檢查憑據和網路設定後重試。",
    },
  },
  en: {
    proxy: {
      reachable: (endpoint, location) =>
        ["The proxy is reachable", endpoint, location]
          .filter(Boolean)
          .join(" · "),
      disabled: "Enable the proxy server before testing it.",
      configurationMissing: "Enter a proxy host and port before testing it.",
      credentialMissing:
        "Proxy authentication is enabled. Enter a proxy password before testing.",
      timeout:
        "The proxy test timed out. Check whether the proxy service is reachable.",
      httpError: (status) =>
        status === undefined
          ? "The proxy test returned an error response. Check the proxy service and test URL."
          : `The proxy test returned HTTP ${status}. Check the proxy service and test URL.`,
      unreachable:
        "The proxy is unreachable. Check its host, port, and authentication settings.",
    },
    bot: {
      credentialsValid: (username) =>
        username
          ? `The credential check passed · ${username}. This does not mean the message listener is running.`
          : "The credential check passed. This does not mean the message listener is running.",
      tokenMissing: "Enter a Bot Token before testing the connection.",
      tokenInvalid: "The Bot Token is invalid. Check it and try again.",
      appCredentialsMissing:
        "Enter an App ID and App Secret before testing the connection.",
      connectionFailed:
        "Check the credentials and network settings, then try again.",
    },
  },
} satisfies UiCatalog<SettingsTestResultCopy>;

export function settingsTestResultMessage(
  result: SettingsTestResult,
  locale: UiLocale,
): string {
  const copy = COPY[locale];
  const status = numberDetail(result, "status");
  switch (result.code) {
    case "proxy_reachable":
      return copy.proxy.reachable(
        stringDetail(result, "endpoint"),
        proxyLocation(result),
      );
    case "proxy_disabled":
      return copy.proxy.disabled;
    case "proxy_configuration_missing":
      return copy.proxy.configurationMissing;
    case "proxy_credential_missing":
      return copy.proxy.credentialMissing;
    case "proxy_timeout":
      return copy.proxy.timeout;
    case "proxy_http_error":
      return copy.proxy.httpError(status);
    case "proxy_unreachable":
      return copy.proxy.unreachable;
    case "bot_credentials_valid":
      return copy.bot.credentialsValid(identityUsername(result));
    case "bot_token_missing":
      return copy.bot.tokenMissing;
    case "bot_token_invalid":
      return copy.bot.tokenInvalid;
    case "bot_app_credentials_missing":
      return copy.bot.appCredentialsMissing;
    case "bot_connection_failed":
      return copy.bot.connectionFailed;
    default:
      return locale === "en" && result.message.trim()
        ? result.message
        : copy.bot.connectionFailed;
  }
}

function proxyLocation(result: SettingsTestResult): string | undefined {
  const ip = stringDetail(result, "ip");
  if (!ip) return undefined;
  const flag = stringDetail(result, "countryFlag");
  return flag ? `${flag} ${ip}` : ip;
}

function identityUsername(result: SettingsTestResult): string | undefined {
  const identity = result.details?.identity;
  if (!identity || typeof identity !== "object") return undefined;
  const username = (identity as { username?: unknown }).username;
  return typeof username === "string" && username.trim() ? username : undefined;
}

function stringDetail(
  result: SettingsTestResult,
  key: string,
): string | undefined {
  const value = result.details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberDetail(
  result: SettingsTestResult,
  key: string,
): number | undefined {
  const value = result.details?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
