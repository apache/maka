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

const OMITTED_RUNTIME_EXPORTS = new Set<string>();

function isIconComponent(value: unknown): value is IconEntry['Comp'] {
  return typeof value === 'function' || (typeof value === 'object' && value !== null);
}

const LUCIDE_ICONS: IconEntry[] = Object.entries(Icons)
  .filter(([name, value]) => !OMITTED_RUNTIME_EXPORTS.has(name) && isIconComponent(value))
  .map(([name, value]) => ({ name, Comp: value as IconEntry['Comp'] }))
  .sort((a, b) => a.name.localeCompare(b.name));

const BOT_BRAND_PROVIDERS = [
  'telegram',
  'feishu',
  'wecom',
  'wechat',
  'discord',
  'dingtalk',
  'qq',
  'slack',
  'whatsapp',
] as const satisfies ReadonlyArray<keyof typeof BOT_BRAND>;

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
              boxShadow: 'var(--shadow-minimal-flat)',
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
              boxShadow: 'var(--shadow-minimal-flat)',
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
