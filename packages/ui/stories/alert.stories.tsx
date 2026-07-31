import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from '@maka/ui/icons';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../src/primitives/alert.js';
import { Button } from '../src/index.js';

const meta = {
  title: 'Primitives/Alert',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const ICONS = {
  default: <Info size={16} strokeWidth={1.75} aria-hidden="true" />,
  error: <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />,
  info: <Info size={16} strokeWidth={1.75} aria-hidden="true" />,
  success: <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />,
  warning: <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />,
} as const;

const VARIANTS = ['default', 'error', 'info', 'success', 'warning'] as const;

export const TitleOnly: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
      {VARIANTS.map((variant) => (
        <Alert key={variant} variant={variant}>
          {ICONS[variant]}
          <AlertTitle>{variant} 标题</AlertTitle>
        </Alert>
      ))}
    </div>
  ),
};

export const TitleAndDescription: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
      {VARIANTS.map((variant) => (
        <Alert key={variant} variant={variant}>
          {ICONS[variant]}
          <AlertTitle>{variant} 标题</AlertTitle>
          <AlertDescription>这条说明文字配合 {variant} 样式，验证图标、标题和描述的排版。</AlertDescription>
        </Alert>
      ))}
    </div>
  ),
};

export const WithAction: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
      {VARIANTS.map((variant) => (
        <Alert key={variant} variant={variant}>
          {ICONS[variant]}
          <AlertTitle>{variant} 标题</AlertTitle>
          <AlertDescription>带操作按钮的 alert，操作区在右侧。</AlertDescription>
          <AlertAction>
            <Button variant="ghost" size="sm" label="查看" />
          </AlertAction>
        </Alert>
      ))}
    </div>
  ),
};

export const WithoutIcon: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
      <Alert variant="info">
        <AlertTitle>无图标 info</AlertTitle>
          <AlertDescription>验证 has-[&gt;svg] 选择器不影响无图标布局。</AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>无图标 warning</AlertTitle>
        <AlertDescription>带操作按钮但无图标。</AlertDescription>
        <AlertAction>
          <Button variant="ghost" size="sm" label="忽略" />
        </AlertAction>
      </Alert>
    </div>
  ),
};