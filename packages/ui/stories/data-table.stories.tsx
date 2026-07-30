import type { Meta, StoryObj } from '@storybook/react-vite';
import { DataTable } from '../src/primitives/data-table.js';

const meta = {
  title: 'Primitives/DataTable',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const REQUEST_COLUMNS = [
  { header: '时间' },
  { header: '类型' },
  { header: '对象', grow: true },
  { header: '会话' },
  { header: 'Token', numeric: true },
  { header: '费用', numeric: true },
  { header: '延迟', numeric: true },
  { header: '状态' },
];

const REQUEST_ROWS = [
  [
    '2026/7/25 14:02:11',
    '模型',
    'anthropic/claude-sonnet-4-5-20250929-preview-extended-thinking',
    'b0efaaf9',
    16_200,
    '$0.04',
    '2840ms',
    '成功',
  ],
  [
    '2026/7/25 13:57:40',
    '工具',
    'mcp__cloud_workspace__list_repository_branch_protection_rules',
    'b0efaaf9',
    1_400,
    '-',
    '640ms',
    '成功',
  ],
  ['2026/7/25 13:41:05', '模型', 'glm-4.7', '9d2612da', 8_600, '$0.01', '1900ms', '失败'],
];

export const Basic: Story = {
  render: () => (
    <div style={{ width: 640 }}>
      <DataTable
        ariaLabel="Providers table"
        columns={[
          { header: 'Provider', grow: true },
          { header: 'Requests', numeric: true },
          { header: 'Cost', numeric: true },
        ]}
        rows={[
          ['Anthropic', 280, '$1.50'],
          ['OpenAI', 140, '$0.84'],
        ]}
      />
    </div>
  ),
};

/**
 * #1360 (found by the #1364 pass): every non-grow column keeps one line by
 * recipe, so the table's min-content width is the sum of its widest cells —
 * a dated preview model id plus a namespaced MCP tool name exceed the
 * settings column even at full window width. The primitive owns the
 * horizontal scroller; the container here is deliberately narrower than the
 * table's min-content so the broken variant stays covered.
 */
export const WideContentScrolls: Story = {
  render: () => (
    <div style={{ width: 420 }}>
      <DataTable ariaLabel="请求日志" columns={REQUEST_COLUMNS} rows={REQUEST_ROWS} />
    </div>
  ),
};
