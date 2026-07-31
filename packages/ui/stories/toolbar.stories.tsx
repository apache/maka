import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, FolderOpen, Save, Trash2 } from '@maka/ui/icons';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '../src/primitives/toolbar.js';
import { Button } from '../src/index.js';

const meta = {
  title: 'Primitives/Toolbar',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const ArtifactActions: Story = {
  render: () => (
    <Toolbar aria-label="生成文件操作" style={{ width: 520 }}>
      <ToolbarGroup>
        <Button variant="secondary" size="sm" icon={<FolderOpen size={14} aria-hidden="true" />} label="在 Finder 中打开" />
        <Button variant="secondary" size="sm" icon={<Save size={14} aria-hidden="true" />} label="另存为" />
        <Button variant="secondary" size="sm" icon={<Copy size={14} aria-hidden="true" />} label="复制文本" />
      </ToolbarGroup>
      <ToolbarSeparator orientation="vertical" />
      <ToolbarGroup>
        <Button variant="destructive" size="sm" icon={<Trash2 size={14} aria-hidden="true" />} label="删除" />
      </ToolbarGroup>
    </Toolbar>
  ),
};