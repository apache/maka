import type {
  AppSettings,
  BotProvider,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core';
import { botDisplayLabel, generalizedErrorMessageChinese, redactSecrets } from '@maka/core';
import { SENSITIVE_PLACEHOLDER, maskSensitive } from '@maka/core/settings/network-settings';
import type { BotTestResult } from '@maka/runtime';
import { collectPersonalizationWarnings } from '@maka/runtime';
import { getTavilyCredentialSource } from './web-search/credentials.js';

export function preserveSensitivePlaceholders(
  patch: UpdateAppSettingsInput,
  current: AppSettings,
): UpdateAppSettingsInput {
  const botChannels = patch.botChat?.channels
    ? Object.fromEntries(
        Object.entries(patch.botChat.channels).map(([provider, channelPatch]) => {
          const currentChannel = current.botChat.channels[provider as BotProvider];
          return [
            provider,
            {
              ...channelPatch,
              ...(channelPatch?.token === SENSITIVE_PLACEHOLDER ? { token: currentChannel.token } : {}),
              ...(channelPatch?.appSecret === SENSITIVE_PLACEHOLDER ? { appSecret: currentChannel.appSecret } : {}),
            },
          ];
        }),
      )
    : undefined;

  return {
    ...patch,
    ...(patch.network?.proxy?.password === SENSITIVE_PLACEHOLDER
      ? {
          network: {
            ...patch.network,
            proxy: {
              ...patch.network.proxy,
              password: current.network.proxy.password,
            },
          },
        }
      : {}),
    ...(botChannels
      ? {
          botChat: {
            ...patch.botChat,
            channels: botChannels,
          },
        }
      : {}),
  };
}

export function maskAppSettings(settings: AppSettings, revealPatch: UpdateAppSettingsInput = {}): AppSettings {
  return {
    ...settings,
    network: {
      ...settings.network,
      proxy: {
        ...settings.network.proxy,
        password: shouldReveal(revealPatch.network?.proxy?.password)
          ? settings.network.proxy.password
          : maskSensitive(settings.network.proxy.password) ?? '',
      },
    },
    botChat: {
      ...settings.botChat,
      channels: Object.fromEntries(
        Object.entries(settings.botChat.channels).map(([provider, channel]) => [
          provider,
          {
            ...channel,
            token: shouldReveal(revealPatch.botChat?.channels?.[provider as BotProvider]?.token)
              ? channel.token
              : maskSensitive(channel.token) ?? '',
            appSecret: shouldReveal(revealPatch.botChat?.channels?.[provider as BotProvider]?.appSecret)
              ? channel.appSecret
              : maskSensitive(channel.appSecret) ?? '',
          },
        ]),
      ) as AppSettings['botChat']['channels'],
    },
    // PR-WEB-SEARCH-TAVILY-0: Tavily API key is masked at the IPC
    // store boundary. Renderer never sees the cleartext value;
    // re-submitting the masked sentinel is treated as "keep current"
    // in `mergeWebSearchSettings`.
    webSearch: {
      ...settings.webSearch,
      providers: {
        tavily: {
          ...settings.webSearch.providers.tavily,
          apiKey: maskSensitive(settings.webSearch.providers.tavily.apiKey) ?? '',
          credentialSource: getTavilyCredentialSource(settings),
        },
      },
    },
  };
}

/**
 * Return a copy of settings with every secret field OMITTED, for a config
 * export that does NOT include the `credentials` category. The keys are
 * removed (not blanked to '') on purpose: `mergeSettings` deep-merges to the
 * leaf, so an absent key preserves the target machine's existing value on
 * import, whereas a '' would overwrite and wipe a working proxy/bot/search
 * secret. Keep the field list in sync with `maskAppSettings`.
 */
export function stripSettingsSecretsForExport(settings: AppSettings): Record<string, unknown> {
  const proxy = { ...settings.network.proxy } as Record<string, unknown>;
  delete proxy.password;

  const channels: Record<string, unknown> = {};
  for (const [provider, channel] of Object.entries(settings.botChat.channels)) {
    const next = { ...channel } as Record<string, unknown>;
    delete next.token;
    delete next.appSecret;
    channels[provider] = next;
  }

  const tavily = { ...settings.webSearch.providers.tavily } as Record<string, unknown>;
  delete tavily.apiKey;

  return {
    ...settings,
    network: { ...settings.network, proxy },
    botChat: { ...settings.botChat, channels },
    webSearch: { ...settings.webSearch, providers: { ...settings.webSearch.providers, tavily } },
  };
}

export function buildSettingsUpdateResult(
  settings: AppSettings,
  patch: UpdateAppSettingsInput,
): UpdateAppSettingsResult {
  const personalization = collectPersonalizationWarnings(patch.personalization);
  return {
    settings: maskAppSettings(settings, patch),
    ...(personalization.length ? { warnings: { personalization } } : {}),
  };
}

function shouldReveal(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && value !== SENSITIVE_PLACEHOLDER;
}

export function toSettingsTestResult(provider: BotProvider, result: BotTestResult): SettingsTestResult {
  return {
    ok: result.ok,
    message: result.ok
      ? `${provider} 凭据测试成功${result.identity?.username ? `：${result.identity.username}` : ''}。这不代表运行态已接收或发送成功。`
      : botTestErrorMessage(provider, result.error),
    details: {
      ...(result.identity ? { identity: result.identity } : {}),
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
      ...(result.hint ? { hint: result.hint } : {}),
    },
  };
}

export function botTestErrorMessage(provider: BotProvider, error: unknown): string {
  const label = botDisplayLabel(provider);
  const raw = redactSecrets(error instanceof Error ? error.message : String(error ?? '')).trim();
  const lower = raw.toLowerCase();

  if (!raw) return `${label} 连接测试失败，请检查凭据和网络后重试。`;
  if (lower.includes('bot token is required')) return `${label} 需要 Bot Token，请填写后再测试。`;
  if (lower.includes('invalid bot token')) return `${label} 的 Bot Token 无效，请检查后重试。`;
  if (provider === 'feishu' && /appid|app_id|appsecret|app_secret|required/.test(lower)) {
    return '飞书需要 App ID 和 App Secret，请填写后再测试。';
  }

  const classified = generalizedErrorMessageChinese(raw, '');
  if (classified) return `${label} 连接测试失败：${classified}。`;
  if (/[\u3400-\u9fff]/.test(raw)) return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
  return `${label} 连接测试失败，请检查凭据和网络后重试。`;
}
