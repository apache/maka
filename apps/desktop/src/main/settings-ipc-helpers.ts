import type {
  AppSettings,
  SettingsTestResult,
  SettingsTestResultCode,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core/settings';
import type { BotProvider } from '@maka/core/bot-chat-settings';
import { botDisplayLabel } from '@maka/core/bot-events';
import { generalizedErrorMessage, redactSecrets } from '@maka/core/redaction';
import {
  SENSITIVE_PLACEHOLDER,
  maskSensitive,
  type TestProxyResult,
} from "@maka/core/settings/network-settings";
import type { BotTestResult } from '@maka/runtime/bots';
import { collectPersonalizationWarnings } from '@maka/runtime/system-prompt/personalization-prompt';
import { getTavilyCredentialSource } from "./web-search/credentials.js";

export function proxyTestFailure(result: TestProxyResult): {
  code: SettingsTestResultCode;
  message: string;
} {
  const raw = redactSecrets(result.error ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("proxy disabled")) {
    return { code: "proxy_disabled", message: "The proxy is disabled." };
  }
  if (lower.includes("proxy host/port required"))
    return {
      code: "proxy_configuration_missing",
      message: "The proxy host or port is missing.",
    };
  if (lower.includes("proxy test timeout") || lower.includes("timeout"))
    return { code: "proxy_timeout", message: "The proxy test timed out." };
  if (result.status)
    return {
      code: "proxy_http_error",
      message: `The proxy test returned HTTP ${result.status}.`,
    };
  const classified = generalizedErrorMessage(raw, "");
  return {
    code: "proxy_unreachable",
    message: classified || "The proxy is unreachable.",
  };
}

export function preserveSensitivePlaceholders(
  patch: UpdateAppSettingsInput,
  current: AppSettings,
): UpdateAppSettingsInput {
  const botChannels = patch.botChat?.channels
    ? Object.fromEntries(
        Object.entries(patch.botChat.channels).map(
          ([provider, channelPatch]) => {
            const currentChannel =
              current.botChat.channels[provider as BotProvider];
            return [
              provider,
              {
                ...channelPatch,
                ...(channelPatch?.token === SENSITIVE_PLACEHOLDER
                  ? { token: currentChannel.token }
                  : {}),
                ...(channelPatch?.appSecret === SENSITIVE_PLACEHOLDER
                  ? { appSecret: currentChannel.appSecret }
                  : {}),
              },
            ];
          },
        ),
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

export function maskAppSettings(
  settings: AppSettings,
  revealPatch: UpdateAppSettingsInput = {},
): AppSettings {
  return {
    ...settings,
    network: {
      ...settings.network,
      proxy: {
        ...settings.network.proxy,
        password: shouldReveal(revealPatch.network?.proxy?.password)
          ? settings.network.proxy.password
          : (maskSensitive(settings.network.proxy.password) ?? ""),
      },
    },
    botChat: {
      ...settings.botChat,
      channels: Object.fromEntries(
        Object.entries(settings.botChat.channels).map(([provider, channel]) => [
          provider,
          {
            ...channel,
            token: shouldReveal(
              revealPatch.botChat?.channels?.[provider as BotProvider]?.token,
            )
              ? channel.token
              : (maskSensitive(channel.token) ?? ""),
            appSecret: shouldReveal(
              revealPatch.botChat?.channels?.[provider as BotProvider]
                ?.appSecret,
            )
              ? channel.appSecret
              : (maskSensitive(channel.appSecret) ?? ""),
          },
        ]),
      ) as AppSettings["botChat"]["channels"],
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
          apiKey:
            maskSensitive(settings.webSearch.providers.tavily.apiKey) ?? "",
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
export function stripSettingsSecretsForExport(
  settings: AppSettings,
): Record<string, unknown> {
  const proxy = { ...settings.network.proxy } as Record<string, unknown>;
  delete proxy.password;

  const channels: Record<string, unknown> = {};
  for (const [provider, channel] of Object.entries(settings.botChat.channels)) {
    const next = { ...channel } as Record<string, unknown>;
    delete next.token;
    delete next.appSecret;
    channels[provider] = next;
  }

  const tavily = { ...settings.webSearch.providers.tavily } as Record<
    string,
    unknown
  >;
  delete tavily.apiKey;

  return {
    ...settings,
    network: { ...settings.network, proxy },
    botChat: { ...settings.botChat, channels },
    webSearch: {
      ...settings.webSearch,
      providers: { ...settings.webSearch.providers, tavily },
    },
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
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== SENSITIVE_PLACEHOLDER
  );
}

export function toSettingsTestResult(
  provider: BotProvider,
  result: BotTestResult,
): SettingsTestResult {
  const failure = result.ok
    ? undefined
    : botTestFailure(provider, result.error);
  return {
    ok: result.ok,
    code: result.ok ? "bot_credentials_valid" : failure?.code,
    message: result.ok
      ? `${botDisplayLabel(provider)} credentials are valid${result.identity?.username ? ` for ${result.identity.username}` : ""}.`
      : (failure?.message ??
        `${botDisplayLabel(provider)} connection test failed.`),
    details: {
      ...(result.identity ? { identity: result.identity } : {}),
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
      ...(result.hint ? { hint: result.hint } : {}),
    },
  };
}

export function botTestErrorMessage(
  provider: BotProvider,
  error: unknown,
): string {
  return botTestFailure(provider, error).message;
}

function botTestFailure(
  provider: BotProvider,
  error: unknown,
): { code: SettingsTestResultCode; message: string } {
  const label = botDisplayLabel(provider);
  const raw = redactSecrets(
    error instanceof Error ? error.message : String(error ?? ""),
  ).trim();
  const lower = raw.toLowerCase();

  if (lower.includes("bot token is required")) {
    return {
      code: "bot_token_missing",
      message: `${label} requires a Bot Token.`,
    };
  }
  if (lower.includes("invalid bot token")) {
    return {
      code: "bot_token_invalid",
      message: `${label} rejected the Bot Token.`,
    };
  }
  if (
    provider === "feishu" &&
    /appid|app_id|appsecret|app_secret|required/.test(lower)
  ) {
    return {
      code: "bot_app_credentials_missing",
      message: "Feishu requires an App ID and App Secret.",
    };
  }

  const classified = generalizedErrorMessage(raw, "");
  return {
    code: "bot_connection_failed",
    message: classified
      ? `${label} connection test failed: ${classified}.`
      : `${label} connection test failed.`,
  };
}
