import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/index.js';

const meta = {
  title: 'Primitives/Badge',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// #1565 PR 3: the cva recipe collapsed onto the Astryx Badge. The status row
// covers every tone statusBadgeVariant maps onto (success / warning / error /
// info / neutral); the palette row covers the non-semantic color set.
const STATUS_VARIANTS = ['neutral', 'info', 'success', 'warning', 'error'] as const;
const PALETTE_VARIANTS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow'] as const;

export const BadgeMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
        {STATUS_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant} label={variant} />
        ))}
      </div>
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {PALETTE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant} label={variant} />
        ))}
      </div>
    </div>
  ),
};
