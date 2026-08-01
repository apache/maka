import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from '@maka/ui/icons';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';

const meta = {
  title: 'Primitives/Menu',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function OpenMenuCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: 220, minWidth: 180 }}>
      <DropdownMenu
        isMenuOpen
        button={{ label, variant: 'secondary', size: 'sm' }}
      >
        {children}
      </DropdownMenu>
    </div>
  );
}

export const Basic: Story = {
  render: () => (
    <DropdownMenu button={{ label: '打开菜单', variant: 'secondary' }}>
      <DropdownMenuItem label="新建文件" />
      <DropdownMenuItem label="打开…" />
      <DropdownMenuItem label="保存" endContent={<kbd>⌘S</kbd>} />
      <Divider orientation="horizontal" />
      <DropdownMenuItem
        label="删除"
        icon={<Trash2 size={14} aria-hidden="true" />}
        style={{ color: 'var(--destructive-text)' }}
      />
    </DropdownMenu>
  ),
};

function SelectionExamples() {
  const [showLines, setShowLines] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [theme, setTheme] = useState('system');
  return (
    <>
      <OpenMenuCell label="checkbox">
        <DropdownMenuCheckboxItem
          label="显示行号"
          value={showLines}
          onChange={setShowLines}
        />
        <DropdownMenuCheckboxItem label="自动换行" value={wrap} onChange={setWrap} />
      </OpenMenuCell>
      <OpenMenuCell label="radio">
        <DropdownMenuRadioGroup
          value={theme}
          onChange={setTheme}
          aria-label="主题"
        >
          <DropdownMenuRadioItem value="light" label="浅色" />
          <DropdownMenuRadioItem value="dark" label="深色" />
          <DropdownMenuRadioItem value="system" label="跟随系统" />
        </DropdownMenuRadioGroup>
      </OpenMenuCell>
    </>
  );
}

export const OpenMatrix: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gap: 48,
        padding: 40,
        gridTemplateColumns: 'repeat(3, 200px)',
      }}
    >
      <OpenMenuCell label="basic">
        <Divider orientation="horizontal" label="文件" />
        <DropdownMenuItem label="新建文件" />
        <DropdownMenuItem label="打开…" />
        <Divider orientation="horizontal" />
        <DropdownMenuItem
          label="删除"
          style={{ color: 'var(--destructive-text)' }}
        />
      </OpenMenuCell>

      <OpenMenuCell label="shortcuts">
        <DropdownMenuItem label="新建" endContent={<kbd>⌘N</kbd>} />
        <DropdownMenuItem label="打开" endContent={<kbd>⌘O</kbd>} />
        <DropdownMenuItem label="保存" endContent={<kbd>⌘S</kbd>} />
      </OpenMenuCell>

      <SelectionExamples />

      <OpenMenuCell label="flat export actions">
        <DropdownMenuItem
          icon={<Plus size={14} aria-hidden="true" />}
          label="新建"
        />
        <Divider orientation="horizontal" label="导出为" />
        <DropdownMenuItem label="PDF" />
        <DropdownMenuItem label="Markdown" />
        <DropdownMenuItem label="HTML" />
      </OpenMenuCell>

      <OpenMenuCell label="icons">
        <DropdownMenuItem
          icon={<Plus size={14} aria-hidden="true" />}
          label="新建"
        />
        <DropdownMenuItem
          icon={<Trash2 size={14} aria-hidden="true" />}
          label="删除"
          style={{ color: 'var(--destructive-text)' }}
        />
      </OpenMenuCell>
    </div>
  ),
};
