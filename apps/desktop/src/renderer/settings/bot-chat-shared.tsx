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

import type { BotProvider, BotReadinessState } from '@maka/core/bot-chat-settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type { BotStatus } from '@maka/runtime/bots';
import { BotBrandLogo as BotBrandMark } from '@maka/ui';
import { getBotSettingsCopy } from '../locales/settings-bot-copy';

/**
 * Per-platform brand presentation.
 *
 * History:
 * - PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`) shipped single-char
 *   monograms (T / 飞 / 企 / 微 / D / 钉 / Q) tinted with the brand color
 *   as a license/asset-hygiene compromise.
 * - WAWQAQ msg `c8a9fc6f` 2026-06-25 reversed this: "IM 的渠道，这一些
 *   显然应该用真实的图标，而不是用字。就像现在模型的这一些图标都是
 *   用的真实对应公司的图标。" → swap the monogram for the real brand
 *   icon, the same way model providers already use their actual logos.
 *
 * Implementation: `BotBrandMark` renders a local provider SVG. The icons
 * render synchronously offline; `glyph` stays only as metadata for text
 * fallback contexts.
 *
 * `configDocUrl` is the official developer doc surfaced inline as a
 * "查看配置文档" link.
 */
// BOT_BRAND moved to `packages/ui/src/bot-brand.ts` so the ScheduledTask
// delivery picker can use the same brand metadata as Settings here (@kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2). Imported via `@maka/ui`.

// PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6`): help copy
// rewritten per reference screenshots — short product sentence pointing
// at where to provision credentials; not a runtime technical breakdown.
export const BOT_LABELS: Record<BotProvider, { support: 'runtime' | 'credentials' | 'planned' }> = {
  telegram: { support: 'runtime' },
  feishu: { support: 'credentials' },
  wecom: { support: 'credentials' },
  wechat: { support: 'credentials' },
  discord: { support: 'runtime' },
  dingtalk: { support: 'runtime' },
  qq: { support: 'runtime' },
  slack: { support: 'runtime' },
};

export function botReadinessCopyForSupport(support: 'runtime' | 'credentials' | 'planned', readiness: BotReadinessState, locale: UiLocale = 'zh') {
  const copy = getBotSettingsCopy(locale);
  if (support === 'planned') return copy.planned;
  return copy.readiness[readiness] ?? copy.readiness.scaffolded;
}

/** Shared provider logo, compact in the overview and larger in channel detail. */
export function BotBrandLogo(props: { provider: BotProvider; size?: 'compact' | 'large' }) {
  const isLarge = props.size === 'large';
  return (
    <span
      className="settingsBotLogo"
      data-large={isLarge ? 'true' : undefined}
      data-provider={props.provider}
      aria-hidden="true"
    >
      {/* PR-BOT-LOGO-NEUTRAL-PLATE-0 (WAWQAQ msg `f3d263b4`
          2026-06-26): real iOS-app-icon style. The brand SVG carries
          the brand-color disc + white official mark (Telegram blue
          gradient + paper plane, WeChat green + double-bubble,
          Discord blurple + Clyde, Feishu 3-color staircase, …) —
          see `packages/ui/src/bot-brand-logo.tsx`. width/height
          100% so the brand tile fills `.settingsBotLogo` edge-to-
          edge; the parent plate is transparent so the brand-color
          disc IS the visible tile. */}
      <BotBrandMark
        provider={props.provider}
        width="100%"
        height="100%"
        aria-hidden="true"
      />
    </span>
  );
}

export type BotPendingActionName = 'test' | 'connect' | 'restart' | 'disconnect';
export type BotPendingAction = { provider: BotProvider; action: BotPendingActionName };

export function botStatusDetail(status: BotStatus, locale: UiLocale = 'zh'): string {
  const copy = getBotSettingsCopy(locale).status;
  switch (status.reason) {
    case 'disabled': return copy.disabled;
    case 'no-token': return copy.noToken;
    case 'missing-feishu-credentials': return copy.missingFeishuCredentials;
    case 'feishu-domain-required': return copy.feishuDomainRequired;
    case 'feishu-events-not-connected': return copy.feishuEventsNotConnected;
    case 'scaffold-only': return copy.unavailable;
    case 'unimplemented': return copy.unavailable;
    case 'stopped': return copy.stopped;
    // PR-BOT-CHAT-POLISH-0: the previous fallback `status.reason ??
    // '暂无运行细节'` would surface a raw reason code (e.g.
    // `polling-timeout`) for any unmapped state. That's noise the
    // user can't act on; collapse to a generalized copy.
    default: return copy.detailsInLogs;
  }
}
