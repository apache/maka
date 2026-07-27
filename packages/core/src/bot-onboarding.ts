import type { BotProvider } from './bot-chat-settings.js';

export const BOT_ONBOARDING_PROVIDERS = [
  'dingtalk',
  'feishu',
  'wecom',
  'wechat',
  'qq',
  'whatsapp',
] as const satisfies ReadonlyArray<BotProvider>;

export type BotOnboardingProvider = (typeof BOT_ONBOARDING_PROVIDERS)[number];
export type BotOnboardingBrand = 'feishu' | 'lark';

export const BOT_ONBOARDING_STATES = [
  'waiting',
  'scanned',
  'connecting',
  'connected',
  'expired',
  'denied',
  'cancelled',
  'error',
] as const;

export type BotOnboardingState = (typeof BOT_ONBOARDING_STATES)[number];

export interface BotOnboardingStartInput {
  provider: BotOnboardingProvider;
  /** Feishu and Lark share one Maka channel but use different account domains. */
  brand?: BotOnboardingBrand;
}

/**
 * Renderer-safe projection of a main-process-owned onboarding session.
 * Provider device codes and final credentials never cross the preload boundary.
 */
export interface BotOnboardingSnapshot {
  sessionId: string;
  provider: BotOnboardingProvider;
  brand?: BotOnboardingBrand;
  state: BotOnboardingState;
  qrCodeDataUrl?: string;
  expiresAt?: number;
  nextPollAfterMs: number;
  canOpenInBrowser: boolean;
  identity?: {
    id?: string;
    displayName?: string;
  };
  error?: string;
  /**
   * Set on a `connected` snapshot when the channel was saved successfully but
   * the live bridge did not reach a running/healthy state within the commit
   * window. The saved channel is valid and persisted; this is an honest,
   * redacted notice (never carries provider credentials) that the connection
   * still needs to be (re)established — never a hard failure of onboarding.
   */
  warning?: string;
}

export function isBotOnboardingProvider(value: unknown): value is BotOnboardingProvider {
  return (
    typeof value === 'string' && (BOT_ONBOARDING_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isBotOnboardingBrand(value: unknown): value is BotOnboardingBrand {
  return value === 'feishu' || value === 'lark';
}
