import type { BotOnboardingProvider } from '@maka/core/bot-onboarding';
import type { BotOnboardingProviderAdapter } from './bot-onboarding-main.js';

type AdapterMap = Partial<Record<BotOnboardingProvider, BotOnboardingProviderAdapter>>;

const POLL_INTERVAL_MS = 1_000;
const NORMAL_TTL_SECONDS = 30;
// #1233 deferral (settings-bots-onboarding): a long TTL keeps the deterministic
// waiting-state QR from flipping to '二维码已过期' during the fixture settle
// window; a poll that never leaves 'pending' holds the modal in 'waiting'.
const WAITING_HOLD_TTL_SECONDS = 60 * 60;

/**
 * Deterministic provider adapters for the dev-only Settings e2e-fixture.
 * They exercise the real main-owned session, IPC, persistence, runtime-effect,
 * and renderer polling paths without contacting an external IM platform.
 *
 * Scenario-aware: the `settings-bots-onboarding` fixture needs the modal frozen
 * in its 'waiting' state so the QR-onboarding capture is stable, so every
 * provider holds a fixed QR + long TTL + never-confirming poll. All other
 * scenarios keep the scanned → confirmed happy-path adapters the E2E
 * onboarding specs rely on.
 */
export function createE2eFixtureBotOnboardingAdapters(): AdapterMap {
  if (process.env.MAKA_E2E_FIXTURE === 'settings-bots-onboarding') {
    return createWaitingHoldBotOnboardingAdapters();
  }
  const pollCounts = new Map<string, number>();
  let startSequence = 0;
  let wecomStartCount = 0;

  function nextPoll(token: string | undefined): number {
    const key = token ?? 'missing';
    const count = (pollCounts.get(key) ?? 0) + 1;
    pollCounts.set(key, count);
    return count;
  }

  function start(provider: BotOnboardingProvider, expiresInSeconds = NORMAL_TTL_SECONDS) {
    startSequence += 1;
    return {
      opaqueToken: `e2e-fixture-${provider}-${startSequence}`,
      qrValue: `https://example.com/maka/bot-onboarding/${provider}`,
      verificationUrl: `https://example.com/maka/bot-onboarding/${provider}`,
      pollIntervalMs: POLL_INTERVAL_MS,
      expiresInSeconds,
    };
  }

  async function settlePoll(): Promise<void> {
    // Keeps a real in-flight window so E2E can prove that closing a modal
    // invalidates a late provider result before credentials are persisted.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }

  return {
    dingtalk: {
      async start() { return start('dingtalk'); },
      async poll(session) {
        await settlePoll();
        const pollCount = nextPoll(session.opaqueToken);
        if (pollCount === 1) return { status: 'pending' };
        if (pollCount === 2) return { status: 'scanned' };
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'e2e-fixture-dingtalk-client',
            clientSecret: 'e2e-fixture-dingtalk-secret',
          },
          identity: { id: 'e2e-fixture-dingtalk-client', displayName: 'Maka 测试机器人' },
        };
      },
    },
    feishu: {
      async start() { return start('feishu'); },
      async poll(session) {
        await settlePoll();
        if (nextPoll(session.opaqueToken) === 1) return { status: 'scanned' };
        const brand = session.brand ?? 'feishu';
        return {
          status: 'confirmed',
          credential: {
            provider: 'feishu',
            appId: `e2e-fixture-${brand}-app`,
            appSecret: `e2e-fixture-${brand}-secret`,
            brand,
            botName: 'Maka 测试机器人',
          },
          identity: { id: `e2e-fixture-${brand}-app`, displayName: 'Maka 测试机器人' },
        };
      },
    },
    wecom: {
      async start() {
        wecomStartCount += 1;
        return start('wecom', wecomStartCount === 1 ? 1 : NORMAL_TTL_SECONDS);
      },
      async poll() {
        await settlePoll();
        return { status: 'pending' };
      },
    },
    wechat: {
      async start() { return start('wechat'); },
      async poll() {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
        return {
          status: 'confirmed',
          credential: {
            provider: 'wechat',
            botToken: 'e2e-fixture-wechat-token',
            baseUrl: 'https://ilinkai.weixin.qq.com/',
            botId: 'e2e-fixture-wechat-bot',
            userId: 'e2e-fixture-wechat-user',
          },
          identity: { id: 'e2e-fixture-wechat-bot', displayName: 'Maka 测试机器人' },
        };
      },
    },
    qq: {
      async start() { return start('qq'); },
      async poll(session) {
        await settlePoll();
        if (nextPoll(session.opaqueToken) === 1) return { status: 'scanned' };
        return {
          status: 'confirmed',
          credential: {
            provider: 'qq',
            appId: 'e2e-fixture-qq-app',
            appSecret: 'e2e-fixture-qq-secret',
          },
          identity: { id: 'e2e-fixture-qq-app', displayName: 'Maka QQ 测试机器人' },
        };
      },
    },
  };
}

/**
 * #1233 deferral (settings-bots-onboarding): adapters that hold the modal in
 * its 'waiting' state. Every value is FIXED (no Date.now / random) so the
 * rendered QR image is byte-identical across runs, the TTL is long
 * enough to outlast the fixture settle window, and `poll` never leaves
 * 'pending' — so the main service keeps the session 'waiting' and the modal's
 * waiting layout stays put for a deterministic fixture state.
 */
function createWaitingHoldBotOnboardingAdapters(): AdapterMap {
  function waitingHold(provider: BotOnboardingProvider): BotOnboardingProviderAdapter {
    return {
      async start() {
        return {
          opaqueToken: `e2e-fixture-onboarding-${provider}`,
          qrValue: `https://example.com/maka/bot-onboarding/${provider}`,
          verificationUrl: `https://example.com/maka/bot-onboarding/${provider}`,
          pollIntervalMs: POLL_INTERVAL_MS,
          expiresInSeconds: WAITING_HOLD_TTL_SECONDS,
        };
      },
      async poll() {
        return { status: 'pending' };
      },
    };
  }
  return {
    dingtalk: waitingHold('dingtalk'),
    feishu: waitingHold('feishu'),
    wecom: waitingHold('wecom'),
    wechat: waitingHold('wechat'),
    qq: waitingHold('qq'),
  };
}
