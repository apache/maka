import type { BotProvider } from '@maka/core/bot-chat-settings';

export interface BotBrand {
  /** Hex color used as the brand tint behind the logo tile. */
  color: string;
  /** Single-character fallback used by copy/tests when a text fallback is needed. */
  glyph: string;
  /** Optional product-side help link for credential provisioning docs. */
  configDocUrl?: string;
}

// Shared bot brand metadata. Both Settings → 机器人对话 and the chat-side
// ScheduledTask delivery picker needs real brand logos here so the same
// channel reads as the same channel everywhere in the product (kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2).
//
// `BotBrandLogo` owns the per-channel local SVG source and license notes;
// this file stays product metadata only.
//
// PR-BOT-LOGO-NEUTRAL-PLATE-0 (WAWQAQ msg `f3d263b4` 2026-06-26)
// replaces the previous monochrome silhouettes with iOS-app-icon
// style real brand tiles, matching the realism of
// `provider-brand-marks.tsx` for model providers.
// All IM channels render fully offline; nothing falls through to a CDN.
export const BOT_BRAND: Record<BotProvider, BotBrand> = {
  telegram: { color: '#229ED9', glyph: 'T', configDocUrl: 'https://core.telegram.org/bots/tutorial' },
  feishu:   { color: '#00C6B7', glyph: '飞', configDocUrl: 'https://open.feishu.cn/document/server-docs/bot-v3' },
  wecom:    { color: '#0089FF', glyph: '企', configDocUrl: 'https://developer.work.weixin.qq.com/document/' },
  wechat:   { color: '#07C160', glyph: '微', configDocUrl: 'https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html' },
  discord:  { color: '#5865F2', glyph: 'D', configDocUrl: 'https://discord.com/developers/docs/intro' },
  dingtalk: { color: '#1372FB', glyph: '钉', configDocUrl: 'https://open.dingtalk.com/document/' },
  qq:       { color: '#12B7F5', glyph: 'Q', configDocUrl: 'https://bot.q.qq.com/wiki/' },
  slack:    { color: '#4A154B', glyph: 'S', configDocUrl: 'https://api.slack.com/start/quickstart' },
};
