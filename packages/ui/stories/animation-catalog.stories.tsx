import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '../src/primitives/spinner.js';

const meta = {
  title: 'Design System/Animation Catalog',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const RetainedFunctionalMotion: Story = {
  render: () => (
    <div style={{ alignItems: 'end', display: 'grid', gap: 24, gridTemplateColumns: 'repeat(2, minmax(96px, 1fr))' }}>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <Spinner style={{ height: 20, width: 20 }} />
        <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, fontWeight: 600 }}>Spinner</span>
      </div>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            animation: 'maka-shimmer 1.8s var(--ease-linear) infinite',
            background:
              'linear-gradient(120deg, transparent 40%, oklch(from var(--foreground) l c h / 0.16), transparent 60%) var(--foreground-5) 0 0 / 200% 100%',
            borderRadius: 'var(--radius-surface)',
            display: 'inline-block',
            height: 20,
            width: 96,
          }}
        />
        <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, fontWeight: 600 }}>Shimmer</span>
      </div>
    </div>
  ),
};

const durationScale = [
  ['quick', '--duration-quick', '120ms', 'hover/press 触觉反馈、focus ring'],
  ['base', '--duration-base', '150ms', '交互元素 color/border/transform'],
  ['emphasized', '--duration-emphasized', '180ms', '更强的 hover/focus/status 反馈'],
  ['large', '--duration-large', '280ms', '结构性运动,非默认 mount'],
] as const;

export const DurationScale: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <>
      <style>{'@keyframes maka-story-motion-demo { from { transform: translateX(0); } to { transform: translateX(220px); } }'}</style>
      <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Duration Scale</h2>
          <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            按意图选择时长,不凭感觉。token 之外的值需要注释说明。
          </p>
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          {durationScale.map(([name, token, value, usage]) => (
            <div key={name} style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <strong style={{ fontSize: 14, fontWeight: 650 }}>{name}</strong>
                <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{token}</code>
                <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{value}</span>
              </div>
              <div
                style={{
                  background: 'var(--foreground-5)',
                  borderRadius: 'var(--radius-control)',
                  height: 12,
                  overflow: 'hidden',
                  position: 'relative',
                  width: 280,
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: 60,
                    height: '100%',
                    background: 'var(--accent)',
                    borderRadius: 'var(--radius-control)',
                    animation: `maka-story-motion-demo var(${token}) var(--ease-in-out-strong) infinite alternate`,
                  }}
                />
              </div>
              <span style={{ color: 'var(--foreground-secondary)', fontSize: 12 }}>{usage}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  ),
};

const easingScale = [
  ['out-strong', '--ease-out-strong', 'cubic-bezier(0.16, 1, 0.3, 1)', '反馈/状态变化'],
  ['in-out-strong', '--ease-in-out-strong', 'cubic-bezier(0.77, 0, 0.175, 1)', '屏幕内移动'],
  ['drawer', '--ease-drawer', 'cubic-bezier(0.32, 0.72, 0, 1)', 'iOS 风格 drawer/sheet'],
  ['linear', '--ease-linear', 'linear', '无限循环功能性动画 (spinner/shimmer)'],
] as const;

export const EasingScale: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <>
      <style>{'@keyframes maka-story-easing-demo { from { transform: translateX(0); } to { transform: translateX(220px); } }'}</style>
      <section style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Easing Scale</h2>
          <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            自定义曲线,内置 CSS easing 太弱。--ease-out-strong 用于反馈,--ease-in-out-strong 用于移动,--ease-drawer 用于 sheet,--ease-linear 用于无限循环功能性动画。
          </p>
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          {easingScale.map(([name, token, value, usage]) => (
            <div key={name} style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <strong style={{ fontSize: 14, fontWeight: 650 }}>{name}</strong>
                <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{token}</code>
                <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{value}</span>
              </div>
              <div
                style={{
                  background: 'var(--foreground-5)',
                  borderRadius: 'var(--radius-control)',
                  height: 12,
                  overflow: 'hidden',
                  position: 'relative',
                  width: 280,
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: 60,
                    height: '100%',
                    background: 'var(--accent)',
                    borderRadius: 'var(--radius-control)',
                    animation: `maka-story-easing-demo var(--duration-large) var(${token}) infinite alternate`,
                  }}
                />
              </div>
              <span style={{ color: 'var(--foreground-secondary)', fontSize: 12 }}>{usage}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  ),
};
