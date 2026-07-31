import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatTile, type StatTileTone } from '../src/primitives/stat-tile.js';

const meta = {
  title: 'Primitives/StatTile',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const TONES: StatTileTone[] = ['neutral', 'info', 'success', 'warning', 'destructive'];

export const LongUnbrokenValue: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, width: 180 }}>
      <StatTile
        emphasis="filled"
        label="Listen address"
        value="http://127.0.0.1:3939"
        detail="Local only"
      />
      <StatTile
        emphasis="outline"
        label="Access token"
        value="maka_live_token_4f61127a1e66b49c97a1d1c45b0df9f6b28df69c"
        detail="Long unbroken strings wrap inside the tile"
      />
    </div>
  ),
};

export const ToneAndEmphasisMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16 }}>
      {(['outline', 'filled'] as const).map((emphasis) => (
        <div key={emphasis} style={{ display: 'grid', gap: 8 }}>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{emphasis}</span>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))' }}>
            {TONES.map((tone, index) => (
              <StatTile
                key={`${emphasis}-${tone}`}
                emphasis={emphasis}
                tone={tone}
                label={tone}
                value={index === 0 ? 0 : index * 12}
                detail={index === 0 ? 'zero neutral' : 'sample'}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
