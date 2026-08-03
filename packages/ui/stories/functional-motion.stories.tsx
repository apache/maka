import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '@astryxdesign/core/Spinner';

// The two functional animations the product keeps: a spinner and the streaming
// shimmer. Both are load-bearing rather than decorative, so they outlive the
// motion-token rename — unlike the duration/easing scales that used to sit here
// and catalogued Maka's parallel motion vocabulary as if it were the contract.
const meta = {
  title: 'Design System/Functional Motion',
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
