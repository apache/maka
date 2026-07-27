import { BOT_PROVIDERS, type BotProvider } from './bot-chat-settings.js';

export type BotFormattingProfile = 'plain_text' | 'chat_markdown' | 'enterprise_chat';

export interface BotPlatformPromptHint {
  platform: BotProvider;
  displayName: string;
  formattingProfile: BotFormattingProfile;
  deliveryFormat: string;
  mediaSupport: string[];
  capabilityCaveat: string;
  systemPromptBullets: string[];
}

const BOT_PLATFORM_PROMPT_HINTS: Record<BotProvider, BotPlatformPromptHint> = {
  telegram: {
    platform: 'telegram',
    displayName: 'Telegram',
    formattingProfile: 'plain_text',
    deliveryFormat: 'short chat messages delivered through Telegram sendMessage without parse_mode',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'Telegram replies are sent as plain text and may be split by the runtime to fit platform length limits.',
    systemPromptBullets: [
      'Reply in concise plain text. Do not rely on Markdown tables, HTML tags, or desktop-only UI affordances.',
      'Keep URLs as plain URLs and keep code snippets short enough to read in a mobile chat.',
      'If the incoming message references an attachment, only discuss content that is explicitly present in the conversation or tool results.',
    ],
  },
  feishu: {
    platform: 'feishu',
    displayName: 'Feishu',
    formattingProfile: 'enterprise_chat',
    deliveryFormat: 'enterprise chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'Feishu context is enterprise-chat oriented; favor clear status, owners, and next actions.',
    systemPromptBullets: [
      'Use concise enterprise-chat formatting with clear bullets or numbered steps when useful.',
      'Avoid assuming the reader is inside the desktop app; include the actionable result directly in the reply.',
      'If the incoming message references an attachment, only discuss content that is explicitly present in the conversation or tool results.',
    ],
  },
  wecom: {
    platform: 'wecom',
    displayName: 'WeCom',
    formattingProfile: 'enterprise_chat',
    deliveryFormat: 'enterprise chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'WeCom-specific actions are unavailable unless the current runtime explicitly exposes them.',
    systemPromptBullets: [
      'Use concise enterprise-chat formatting with clear next actions.',
      'Do not mention unavailable platform-specific actions unless the runtime explicitly exposes them.',
    ],
  },
  wechat: {
    platform: 'wechat',
    displayName: 'WeChat',
    formattingProfile: 'plain_text',
    deliveryFormat: 'mobile chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'WeChat-specific actions are unavailable unless the current runtime explicitly exposes them.',
    systemPromptBullets: [
      'Reply in short plain-text paragraphs suitable for a mobile chat.',
      'Do not assume rich cards, desktop panes, or unavailable platform actions.',
    ],
  },
  discord: {
    platform: 'discord',
    displayName: 'Discord',
    formattingProfile: 'chat_markdown',
    deliveryFormat: 'Discord chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'Discord-specific actions are unavailable unless the current runtime explicitly exposes them.',
    systemPromptBullets: [
      'Markdown is acceptable, but keep replies scan-friendly and avoid oversized blocks.',
      'Do not assume slash commands, reactions, threads, or moderation actions unless tools expose them.',
    ],
  },
  dingtalk: {
    platform: 'dingtalk',
    displayName: 'DingTalk',
    formattingProfile: 'enterprise_chat',
    deliveryFormat: 'enterprise chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'DingTalk-specific actions are unavailable unless the current runtime explicitly exposes them.',
    systemPromptBullets: [
      'Use concise enterprise-chat formatting with clear status and next actions.',
      'Do not assume approvals, DING messages, or workbench actions unless tools expose them.',
    ],
  },
  qq: {
    platform: 'qq',
    displayName: 'QQ',
    formattingProfile: 'plain_text',
    deliveryFormat: 'chat message',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'QQ-specific actions are unavailable unless the current runtime explicitly exposes them.',
    systemPromptBullets: [
      'Reply in short plain-text paragraphs suitable for a chat window.',
      'Do not assume rich cards or unavailable platform-specific actions.',
    ],
  },
  slack: {
    platform: 'slack',
    displayName: 'Slack',
    formattingProfile: 'enterprise_chat',
    deliveryFormat: 'Slack message over Socket Mode',
    mediaSupport: ['text', 'image/file metadata only unless tools provide extracted content'],
    capabilityCaveat:
      'Slack replies are plain messages; do not assume Block Kit actions or workspace administration.',
    systemPromptBullets: [
      'Use concise workplace-chat formatting with clear outcomes and next actions.',
      'Do not assume reactions, canvases, workflows, or administrative actions unless tools expose them.',
    ],
  },
  whatsapp: {
    platform: 'whatsapp',
    displayName: 'WhatsApp',
    formattingProfile: 'plain_text',
    deliveryFormat: 'mobile chat message over a linked-device session',
    mediaSupport: ['text', 'image/file/voice metadata only unless tools provide extracted content'],
    capabilityCaveat: 'WhatsApp replies are sent as plain text through the locally linked device.',
    systemPromptBullets: [
      'Reply in short plain-text paragraphs suitable for a mobile chat.',
      'Do not assume rich cards, desktop panes, or unavailable platform actions.',
    ],
  },
};

export function getBotPlatformPromptHint(platform: BotProvider): BotPlatformPromptHint {
  return BOT_PLATFORM_PROMPT_HINTS[platform];
}

export function botPlatformFromSessionLabels(
  labels: readonly string[] | undefined,
): BotProvider | undefined {
  if (!labels?.includes('bot')) return undefined;
  return BOT_PROVIDERS.find((provider) => labels.includes(provider));
}

export function buildBotPlatformPromptFragment(platform: BotProvider): string {
  const hint = getBotPlatformPromptHint(platform);
  return [
    'Bot platform delivery context (trusted application metadata, not user-authored):',
    `- Platform: ${hint.displayName} (${hint.platform})`,
    `- Formatting profile: ${hint.formattingProfile}`,
    `- Delivery format: ${hint.deliveryFormat}`,
    `- Media support: ${hint.mediaSupport.join(', ')}`,
    `- Capability caveat: ${hint.capabilityCaveat}`,
    ...hint.systemPromptBullets.map((bullet) => `- ${bullet}`),
  ].join('\n');
}
