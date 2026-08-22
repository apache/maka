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

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ElementType } from 'react';
import * as Icons from '../src/icons.js';
import { BOT_BRAND, BotBrandLogo } from '../src/index.js';

const meta = {
  title: 'Design System/Icons',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

interface IconEntry {
  name: string;
  Comp: ElementType<{ size?: number | string; strokeWidth?: number | string; 'aria-hidden'?: boolean }>;
}

// The icon seam also exports shared metadata such as ICON_SIZE. Keep the story
// self-updating without assuming every runtime export can be rendered.
function isIconComponent(value: unknown): value is IconEntry['Comp'] {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' &&
      value !== null &&
      'render' in value &&
      typeof value.render === 'function')
  );
}

const LUCIDE_ICONS: IconEntry[] = Object.entries(Icons)
  .flatMap(([name, value]) => (isIconComponent(value) ? [{ name, Comp: value }] : []))
  .sort((a, b) => a.name.localeCompare(b.name));

// Derived from BOT_BRAND, the registry BotBrandLogo itself reads. A hand-kept
// list here is satisfied by any subset, so a newly supported channel would
// silently never render.
const BOT_BRAND_PROVIDERS = Object.keys(BOT_BRAND) as Array<keyof typeof BOT_BRAND>;

export const LucideIcons: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 20, maxWidth: 920 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Lucide Icons</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          {LUCIDE_ICONS.length} 个通用 UI 图标,通过 icons.tsx 的 lucide-react re-export 自动追踪。业务代码仍只从 @maka/ui/icons 取图标。
        </p>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        }}
      >
        {LUCIDE_ICONS.map(({ name, Comp }) => (
          <div
            key={name}
            style={{
              display: 'grid',
              gap: 6,
              padding: 10,
              borderRadius: 'var(--radius-surface)',
              boxShadow: 'var(--ring-soft)',
              placeItems: 'center',
              textAlign: 'center',
            }}
          >
            <Comp size={20} />
            <code style={{ color: 'var(--foreground-secondary)', fontSize: 10, wordBreak: 'break-word' }}>{name}</code>
          </div>
        ))}
      </div>
    </section>
  ),
};

export const BotBrandIcons: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 20, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Bot Brand Icons</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          {BOT_BRAND_PROVIDERS.length} 个 IM 渠道品牌图标,本地 React SVG,零运行时 CDN 依赖。
        </p>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {BOT_BRAND_PROVIDERS.map((provider) => (
          <div
            key={provider}
            style={{
              display: 'grid',
              gap: 6,
              padding: 12,
              borderRadius: 'var(--radius-surface)',
              boxShadow: 'var(--ring-soft)',
              placeItems: 'center',
              textAlign: 'center',
            }}
          >
            <BotBrandLogo provider={provider} width={32} height={32} />
            <code style={{ color: 'var(--foreground-secondary)', fontSize: 10 }}>{provider}</code>
          </div>
        ))}
      </div>
    </section>
  ),
};
