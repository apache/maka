export {
  BaseBotAdapter,
  botReadinessFromSettings,
  botSettingsRequireRestart,
} from './base-adapter.js';
export { BotRegistry } from './bot-registry.js';
export { testBotChannel } from './bot-test.js';
export { proxiedFetch } from './proxied-fetch.js';
export { FeishuBotBridge, feishuMessageToEvent } from './feishu-bridge.js';
export {
  getWechatBridgeQrCode,
  mapWechatIlinkMessage,
  normalizeWechatBridgeUrl,
  normalizeWechatIlinkBaseUrl,
  testWechatBridge,
  testWechatIlinkCredentials,
  WechatBridge,
} from './wechat-bridge.js';
export type { WechatBridgeQrCodeResult } from './wechat-bridge.js';
export { WeComBotBridge, wecomTextFrameToEvent } from './wecom-bridge.js';
export { SlackBotBridge, slackMessageToEvent } from './slack-bridge.js';
export {
  startWhatsAppQrLogin,
  type WhatsAppQrLogin,
  type WhatsAppQrLoginPollResult,
} from './whatsapp-auth.js';
export {
  WhatsAppBotBridge,
  whatsappMessageToEvent,
  whatsappTimestampMs,
} from './whatsapp-bridge.js';
export type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotStatus,
  BotTestResult,
  SendCapable,
} from './types.js';
