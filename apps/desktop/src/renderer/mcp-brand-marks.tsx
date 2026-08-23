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

// Official MCP catalog brand marks.
//
// Each mark is LIBRARY-sourced path geometry (official path data + official
// brand hex/licence) — never hand-drawn art. Marks come from three first-party
// icon sources, unified behind one `BrandMark` model that carries each source's
// NATIVE viewBox so no path is rescaled or redrawn:
//   - `simple-icons` (CC0) — the de-facto brand set; 24×24 viewBox, single path.
//     Covers LINE, Google Calendar, Figma, Vercel, Supabase, Notion and
//     Apple (macOS 应用). Per-icon *named* ESM imports so the bundler tree-shakes
//     the multi-thousand icon catalog down to only the marks we render.
//   - Slack: vendored from the repo's bot-channel logo asset (Simple Icons,
//     CC0-1.0 — see packages/ui/src/bot-brand-logo.tsx). simple-icons dropped
//     Slack in v16, so the four glyph paths are pinned here instead; the
//     mark stays library-sourced geometry, never hand-drawn art.
//   - `@ant-design/icons-svg` (MIT, Ant Group) — ships DingTalk's mark, since
//     DingTalk is an Alibaba product. Its AST uses a "64 64 896 896" viewBox; we
//     deep-import only the one `DingtalkOutlined` asn module (sideEffects:false)
//     and flatten its `<path>` children.
//   - `@douyinfe/semi-icons` (MIT, ByteDance) — ships Feishu/Lark's mark, since
//     Feishu is a ByteDance product. Vendored below as path constants (not a
//     package dep) — semi-icons ships React components + ~3k files, so a full dep
//     would couple React and bloat the tree for one mark; mirrors the single-mark
//     vendoring in settings/provider-brand-marks.tsx.
//
// Rendering: each mark is an `<svg>` MOUNTING SHELL wrapping the library's
// `<path>` children. The `<svg>` element is NOT hand-drawn art — it is an inert
// container for LIBRARY-sourced path data. That is the sanctioned reason
// mcp-brand-marks.tsx sits on the icon-governance INLINE_SVG_ALLOWLIST (see
// apps/desktop/src/main/__tests__/icon-governance-contract.test.ts); the
// rot-guard still holds because this file genuinely contains an inline `<svg>`.
//
// Colour: light theme fills each mark with its official brand hex (`mark.hex`).
// Dark theme: marks whose brand hex is too dark to read on the neutral plate
// fall back to `currentColor` via shouldUseCurrentColorOnDark() — a pure,
// unit-tested luminance gate that lives in ./mcp-brand-contrast so it can be
// exercised without JSX. Tiles keep the #1205 neutral-plate recipe.

import type { AbstractNode } from '@ant-design/icons-svg/es/types.js';
import DingtalkOutlined from '@ant-design/icons-svg/es/asn/DingtalkOutlined.js';
import type { CSSProperties, ReactElement } from 'react';
import type { SimpleIcon } from 'simple-icons';
import { siApple, siFigma, siGooglecalendar, siLine, siNotion, siSupabase, siVercel } from 'simple-icons';
import { shouldUseCurrentColorOnDark } from './mcp-brand-contrast.js';
import type { McpCatalogEntry } from './mcp-catalog';

// One or more library path `d` strings, the source viewBox they were authored
// against, and the brand fill hex the dark-plate luminance gate reads.
type BrandMark = {
  paths: string[];
  viewBox: string;
  hex: string;
};

/** simple-icons ship a single path against a 24×24 viewBox. */
function fromSimpleIcon(icon: SimpleIcon): BrandMark {
  return { paths: [icon.path], viewBox: '0 0 24 24', hex: `#${icon.hex}` };
}

// DingTalk (钉钉) — official mark from @ant-design/icons-svg (MIT). We pick the
// OUTLINED (bare pigeon silhouette) over DingtalkCircleFilled: the catalog's
// data-logo recipe already supplies a neutral plate, so the bare glyph reads
// like the Slack/Notion/… marks, whereas the circle-filled variant renders as a
// solid blue disc that double-plates the tile. Filled with the DingTalk brand
// blue (#0089FF family — supersedes the removed --brand-dingtalk #1677ff plate
// tint); the luminance gate keeps it blue in dark (well above the near-black cut).
const DINGTALK_ICON = DingtalkOutlined.icon as AbstractNode;
const DINGTALK_MARK: BrandMark = {
  paths: (DINGTALK_ICON.children ?? []).map((child) => child.attrs.d),
  viewBox: DINGTALK_ICON.attrs.viewBox,
  hex: '#0089FF',
};

// Feishu/Lark (飞书) — official monochrome mark vendored byte-for-byte from
// ByteDance's own first-party icon library:
//   - package: @douyinfe/semi-icons@2.101.0 (MIT, © DouyinFE)
//   - source:  packages/semi-icons/src/svgs/feishu_logo.svg
//   - source SHA-256: 5f9a5066c702ada4acdb752521a7d70293fbe5166ac4a7fa256cff8778670e2d
//   - viewBox 0 0 24 24; all five <path> children copied verbatim (two are the
//     source's degenerate specks near 20,14 — kept for byte fidelity).
// The Feishu mark remains its owner's trademark; used only to identify the
// connector. Filled with the Feishu brand blue (#3370FF — supersedes the removed
// --brand-feishu plate tint); stays blue in dark via the luminance gate.
const FEISHU_MARK: BrandMark = {
  viewBox: '0 0 24 24',
  hex: '#3370FF',
  paths: [
    'M6.13732 3.80654C8.76716 5.98777 11.0232 8.49408 12.7428 11.4327L14.4397 9.75535C15.2458 8.96545 16.2113 8.34129 17.258 7.93496C16.7802 6.31936 16.0033 4.98005 14.9403 3.65376C14.8135 3.49449 14.6185 3.40346 14.4137 3.40346L6.28362 3.40021C6.06906 3.40021 5.9748 3.67001 6.13732 3.80654Z',
    'M20.5703 14.1922L20.58 14.1793L20.6155 14.1146C20.6026 14.1372 20.5864 14.1631 20.5703 14.1922Z',
    'M11.0361 14.5567C12.2714 15.0833 13.3766 15.5287 14.6899 15.883C17.0207 16.5136 19.2311 15.5709 20.3234 13.4872L21.6432 10.8541C21.939 10.2105 22.3128 9.6156 22.7647 9.07273C21.9715 8.78016 21.3149 8.63064 20.4534 8.63064C18.5518 8.63064 16.7606 9.36205 15.4018 10.6948L13.3831 12.6875C12.6647 13.3929 11.878 14.0203 11.0361 14.5567Z',
    'M20.7945 13.7752L20.8039 13.7566L20.8101 13.7473C20.8039 13.7535 20.8007 13.7659 20.7945 13.7752Z',
    'M1.62519 9.74885C1.47889 9.60906 1.23511 9.70983 1.23511 9.91463L1.23834 17.8724C1.23834 18.1 1.34887 18.3112 1.53416 18.4348C3.66663 19.8521 6.15343 20.5998 8.72151 20.5998C11.166 20.5998 13.5488 19.9171 15.6098 18.6266C16.3867 18.139 16.9979 17.7099 17.6512 17.0792C16.6013 17.388 15.4472 17.4075 14.2835 17.0922C9.37815 15.7594 5.20097 13.2044 1.62519 9.74885Z',
  ],
};

// Slack — vendored from the bot-channel logo asset (Simple Icons, CC0-1.0,
// see packages/ui/src/bot-brand-logo.tsx SlackLogo). The four glyph paths sit
// in a 0..16 coordinate space there (translate(4 4) inside the 24×24 badge);
// BrandMark renders a bare glyph on the neutral plate, so the badge rect is
// dropped and the viewBox is the glyphs' own 16×16 space. Filled with the
// official Slack brand plum (#4A154B); the luminance gate keeps it readable in
// dark.
const SLACK_MARK: BrandMark = {
  viewBox: '0 0 16 16',
  hex: '#4A154B',
  paths: [
    'M3.38 9.64a1.69 1.69 0 1 1-1.69-1.69h1.69zM4.23 9.64a1.69 1.69 0 0 1 3.38 0v4.23a1.69 1.69 0 0 1-3.38 0z',
    'M6.36 3.38a1.69 1.69 0 1 1 1.69-1.69v1.69zM6.36 4.23a1.69 1.69 0 0 1 0 3.38H2.13a1.69 1.69 0 0 1 0-3.38z',
    'M12.62 6.36a1.69 1.69 0 1 1 1.69 1.69h-1.69zM11.77 6.36a1.69 1.69 0 0 1-3.38 0V2.13a1.69 1.69 0 0 1 3.38 0z',
    'M9.64 12.62a1.69 1.69 0 1 1-1.69 1.69v-1.69zM9.64 11.77a1.69 1.69 0 0 1 0-3.38h4.23a1.69 1.69 0 0 1 0 3.38z',
  ],
};

// Catalog id → brand mark. Only ids present here render a real library mark (and
// drive the neutral `data-logo` plate in mcp-page.tsx); every other entry falls
// back to its text mark.
const MCP_BRAND_MARKS: Record<string, BrandMark> = {
  slack: SLACK_MARK,
  line: fromSimpleIcon(siLine),
  'google-calendar': fromSimpleIcon(siGooglecalendar),
  figma: fromSimpleIcon(siFigma),
  vercel: fromSimpleIcon(siVercel),
  supabase: fromSimpleIcon(siSupabase),
  notion: fromSimpleIcon(siNotion),
  'macos-apps': fromSimpleIcon(siApple),
  dingtalk: DINGTALK_MARK,
  feishu: FEISHU_MARK,
};

/** True when the catalog entry has a library brand mark. */
export function hasMcpBrandMark(id: string): boolean {
  return id in MCP_BRAND_MARKS;
}

/**
 * Official brand mark for a catalog entry. Renders the library mark when one
 * exists; otherwise falls back to the entry's text mark.
 */
export function McpBrandMark({ entry }: { entry: McpCatalogEntry }): ReactElement {
  const mark = MCP_BRAND_MARKS[entry.id];
  if (!mark) return <span>{entry.mark}</span>;
  // Light theme paints the brand hex; the `.dark` plate flips low-contrast
  // marks to currentColor (see mcp.css). Custom property carries the hex so
  // the theme switch is pure CSS, no re-render.
  const style = { '--mcp-brand-fill': mark.hex } as CSSProperties;
  return (
    <svg
      className="maka-mcp-brand-mark"
      viewBox={mark.viewBox}
      aria-hidden="true"
      style={style}
      data-contrast={shouldUseCurrentColorOnDark(mark.hex) ? 'low' : undefined}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
