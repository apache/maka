import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Search, Trash2 } from '@maka/ui/icons';
import { Button } from '../src/index.js';
import { Spinner } from '@astryxdesign/core/Spinner';

const meta = {
  title: 'Design System/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const colorSwatches = [
  ['background', '--background', '底色'],
  ['foreground', '--foreground', '正文、图标'],
  ['accent', '--accent', '点缀：logo、live dot、focus ring'],
  ['action', '--action', 'CTA 填充：主按钮、提交'],
  ['control', '--control', '选中态：checkbox、switch、progress'],
  ['info', '--info', '提示、警告'],
  ['success', '--success', '成功、已连接'],
  ['destructive', '--destructive', '错误、删除'],
] as const;

const emphasisAliases = [
  '--link',
  '--focus-ring',
  '--status-running',
  '--nav-active',
  '--toast-accent',
] as const;

const foregroundScale = [
  ['foreground-2', '--foreground-2'],
  ['foreground-5', '--foreground-5'],
  ['foreground-10', '--foreground-10'],
  ['muted-foreground', '--muted-foreground'],
  ['foreground-secondary', '--foreground-secondary'],
  ['foreground', '--foreground'],
] as const;

const radiusSamples = [
  ['control', '6px', '--radius-control', 'Buttons, inputs, compact chips', 96, 56],
  ['surface', '8px', '--radius-surface', 'Cards, popovers, code blocks', 112, 64],
  ['modal', '12px', '--radius-modal', 'Dialogs and composer-scale surfaces', 128, 72],
  ['pill', '999px', '--radius-pill', 'Badges, dots, status pills', 144, 56],
] as const;

function SwatchTile({ name, token, fill, usage }: { name: string; token: string; fill: string; usage: string }) {
  const isBackground = token === '--background';
  const isForeground = token === '--foreground';
  const fillStyle = isBackground
    ? {
        background: `var(${token})`,
        boxShadow: 'inset 0 0 0 1px var(--border-strong)',
      }
    : isForeground
      ? {
          background: `var(${token})`,
          boxShadow: 'var(--shadow-minimal-flat)',
        }
      : { background: `var(${token})` };
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <div
        style={{
          ...fillStyle,
          borderRadius: 'var(--radius-surface)',
          height: 56,
          position: 'relative',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 8,
            bottom: 6,
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            color: isForeground ? 'var(--background)' : 'var(--foreground)',
            opacity: 0.7,
          }}
        >
          Aa
        </span>
      </div>
      <strong style={{ fontSize: 12, fontWeight: 600 }}>{name}</strong>
      <code style={{ color: 'var(--foreground-secondary)', fontSize: 11, wordBreak: 'break-word' }}>{token}</code>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 10, lineHeight: 1.3 }}>{usage}</span>
    </div>
  );
}

function ScaleTile({ name, token }: { name: string; token: string }) {
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div
        style={{
          background: `var(${token})`,
          borderRadius: 'var(--radius-control)',
          boxShadow: 'inset 0 0 0 1px var(--border)',
          height: 32,
        }}
      />
      <code style={{ color: 'var(--foreground-secondary)', fontSize: 10, wordBreak: 'break-word' }}>{name}</code>
    </div>
  );
}

export const Colors: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 820 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Colors</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          六色哲学：其余派生色都是 foreground 的 alpha 叠加或 solid 混合。
        </p>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>语义基色</h3>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          }}
        >
          {colorSwatches.map(([name, token, usage]) => (
            <SwatchTile key={token} name={name} token={token} fill={token} usage={usage} />
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>强调色 alias</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {emphasisAliases.map((token) => (
            <code
              key={token}
              style={{
                borderRadius: 'var(--radius-control)',
                background: 'var(--foreground-5)',
                padding: '4px 8px',
                fontSize: 11,
                color: 'var(--foreground-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {token}
            </code>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>
          前景色阶 (foreground-N)
        </h3>
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
          }}
        >
          {foregroundScale.map(([name, token]) => (
            <ScaleTile key={token} name={name} token={token} />
          ))}
        </div>
      </div>
    </section>
  ),
};

export const Radius: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 14, maxWidth: 760 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Radius</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        {radiusSamples.map(([name, value, token, usage, width, height]) => (
          <div
            key={name}
            style={{
              alignItems: 'center',
              display: 'grid',
              gap: 16,
              gridTemplateColumns: 'minmax(0, 1fr) 180px',
              minWidth: 0,
              padding: '10px 0',
            }}
          >
            <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              <strong style={{ fontSize: 14, fontWeight: 650 }}>{name}</strong>
              <span style={{ fontSize: 28, fontWeight: 650, lineHeight: 1 }}>{value}</span>
              <code style={{ color: 'var(--foreground-secondary)', fontSize: 11, wordBreak: 'break-word' }}>{token}</code>
              <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, lineHeight: 1.4 }}>{usage}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  background: 'var(--foreground)',
                  color: 'var(--background)',
                  borderRadius: `var(${token})`,
                  boxShadow:
                    'var(--shadow-medium), inset 0 0 0 1px oklch(from var(--foreground) l c h / 0.10)',
                  height,
                  width,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontVariantNumeric: 'tabular-nums',
                  opacity: 0.92,
                }}
              >
                {value}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  ),
};

export const PrimaryActions: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 20, maxWidth: 760 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Primary Actions</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          variant 落到 token 上的实际效果。
        </p>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>
          variant
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" label="Action primary" />
          <Button variant="secondary" label="Secondary" />
          <Button variant="ghost" label="Ghost" />
          <Button variant="destructive" label="Destructive" />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>
          disabled
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" isDisabled label="Action primary" />
          <Button variant="secondary" isDisabled label="Secondary" />
          <Button variant="ghost" isDisabled label="Ghost" />
          <Button variant="destructive" isDisabled label="Destructive" />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>
          size + icon
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" size="sm" icon={<Plus />} label="Small" />
          <Button variant="primary" icon={<Search />} label="Medium" />
          <Button variant="primary" isIconOnly icon={<Plus />} label="添加" />
          <Button variant="secondary" size="sm" isIconOnly icon={<Trash2 />} label="删除" />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--foreground-secondary)' }}>
          loading
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" isDisabled icon={<Spinner style={{ height: 14, width: 14 }} />} label="Saving" />
          <Button variant="secondary" isDisabled icon={<Spinner style={{ height: 14, width: 14 }} />} label="Syncing" />
          <Button variant="secondary" isDisabled isIconOnly icon={<Trash2 />} label="删除" />
        </div>
      </div>
    </section>
  ),
};

const semanticRoles = [
  ['action', '--action', 'CTA 填充：主按钮、提交、发送'],
  ['control', '--control', '选中态：checkbox、switch、progress'],
  ['link', '--link', '链接文字'],
  ['focus-ring', '--focus-ring', '键盘聚焦环'],
  ['status-running', '--status-running', '运行中状态、live dot'],
  ['nav-active', '--nav-active', '导航选中'],
  ['toast-accent', '--toast-accent', 'toast 强调'],
] as const;

export const SemanticColors: Story = {
  render: () => (
    <section style={{ display: 'grid', gap: 24, maxWidth: 820 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Semantic Color Roles</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          每个 semantic role 独立命名,即使当前多个 alias 指向同一值。PR5 将进一步分离 action/control。
        </p>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
        }}
      >
        {semanticRoles.map(([name, token, usage]) => (
          <SwatchTile key={token} name={name} token={token} fill={token} usage={usage} />
        ))}
      </div>
    </section>
  ),
};
