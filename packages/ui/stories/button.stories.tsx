import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Search, Trash2 } from '@maka/ui/icons';
import { Button } from '../src/index.js';

const meta = {
  title: 'Primitives/Button',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS = ['primary', 'secondary', 'ghost', 'destructive'] as const;

const SIZES = [
  ['sm', 'sm · 28px'],
  ['md', 'md · 32px'],
  ['lg', 'lg · 36px'],
] as const;

const labelStyle: React.CSSProperties = {
  color: 'var(--foreground-secondary)',
  fontSize: 11,
  width: 80,
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: 12 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

export const VariantMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, minWidth: 720 }}>
      {VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          <Button variant={variant} label="新建任务" />
          <Button variant={variant} label="Create task" />
          <Button variant={variant} label="打开 Workspace" />
          <Button variant={variant} isDisabled label="Disabled" />
        </Row>
      ))}
    </div>
  ),
};

export const SizeMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14 }}>
      {SIZES.map(([size, rowLabel]) => (
        <Row key={size} label={rowLabel}>
          <Button size={size} variant="primary" label="中文按钮" />
          <Button size={size} variant="secondary" label="English" />
          <Button size={size} variant="secondary" icon={<Plus aria-hidden="true" />} label="新建 Task" />
          <Button size={size} variant="secondary" isIconOnly icon={<Search aria-hidden="true" />} label="搜索" />
        </Row>
      ))}
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 14 }}>
      <Row label="icon + label">
        <Button variant="primary" icon={<Plus aria-hidden="true" />} label="新建" />
        <Button variant="secondary" icon={<Search aria-hidden="true" />} label="Search" />
        <Button variant="destructive" icon={<Trash2 aria-hidden="true" />} label="删除" />
      </Row>
      <Row label="isIconOnly">
        <Button variant="secondary" isIconOnly icon={<Plus aria-hidden="true" />} label="新建" />
        <Button variant="ghost" isIconOnly icon={<Search aria-hidden="true" />} label="搜索" />
        <Button variant="secondary" size="sm" isIconOnly icon={<Trash2 aria-hidden="true" />} label="删除" />
        <Button variant="secondary" isIconOnly isDisabled icon={<Trash2 aria-hidden="true" />} label="删除" />
      </Row>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button variant="primary" isLoading label="提交中…" />
      <Button variant="secondary" size="sm" isLoading label="Loading…" />
      <Button variant="destructive" isLoading label="删除中…" />
    </div>
  ),
};
