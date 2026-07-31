import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '../src/primitives/spinner.js';

const meta = {
  title: 'Primitives/Spinner',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const SIZES = [16, 20, 24, 32] as const;

export const Sizes: Story = {
  render: () => (
    <div style={{ alignItems: 'center', display: 'flex', gap: 20 }}>
      {SIZES.map((size) => (
        <div key={size} style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
          <Spinner style={{ height: size, width: size }} />
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{size}px</span>
        </div>
      ))}
    </div>
  ),
};