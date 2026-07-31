import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Switch } from '../src/index.js';

const meta = {
  title: 'Primitives/Switch',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12 }}>
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12, width: 80 }}>{label}</span>
      {children}
    </div>
  );
}

export const OnOff: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 240 }}>
      <Row label="off">
        <Switch label="关闭态" value={false} />
      </Row>
      <Row label="on">
        <Switch label="开启态" value />
      </Row>
      <Row label="controlled">
        <ControlledSwitch initial={false} />
      </Row>
      <Row label="controlled on">
        <ControlledSwitch initial />
      </Row>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14, width: 240 }}>
      <Row label="disabled off">
        <Switch label="禁用关闭" value={false} isDisabled />
      </Row>
      <Row label="disabled on">
        <Switch label="禁用开启" value isDisabled />
      </Row>
    </div>
  ),
};

function ControlledSwitch({ initial }: { initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  return <Switch label="受控开关" value={checked} onChange={setChecked} />;
}
