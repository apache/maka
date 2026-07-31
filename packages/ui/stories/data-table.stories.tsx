import type { Meta, StoryObj } from '@storybook/react-vite';
import { Table, proportional, type TableColumn } from '@astryxdesign/core';

const meta = {
  title: 'Astryx/Table',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

type RequestRow = Record<string, unknown> & {
  id: number;
  time: string;
  kind: string;
  target: string;
  session: string;
  tokens: number;
  cost: string;
  latency: string;
  status: string;
};

const REQUEST_COLUMNS: Array<TableColumn<RequestRow>> = [
  { key: 'time', header: '时间' },
  { key: 'kind', header: '类型' },
  { key: 'target', header: '对象', width: proportional(1) },
  { key: 'session', header: '会话' },
  { key: 'tokens', header: 'Token', align: 'end' },
  { key: 'cost', header: '费用', align: 'end' },
  { key: 'latency', header: '延迟', align: 'end' },
  { key: 'status', header: '状态' },
];

const REQUEST_ROWS: RequestRow[] = [
  { id: 1, time: '2026/7/25 14:02:11', kind: '模型', target: 'anthropic/claude-sonnet-4-5-20250929-preview-extended-thinking', session: 'b0efaaf9', tokens: 16_200, cost: '$0.04', latency: '2840ms', status: '成功' },
  { id: 2, time: '2026/7/25 13:57:40', kind: '工具', target: 'mcp__cloud_workspace__list_repository_branch_protection_rules', session: 'b0efaaf9', tokens: 1_400, cost: '-', latency: '640ms', status: '成功' },
  { id: 3, time: '2026/7/25 13:41:05', kind: '模型', target: 'glm-4.7', session: '9d2612da', tokens: 8_600, cost: '$0.01', latency: '1900ms', status: '失败' },
];

export const Basic: Story = {
  render: () => (
    <div style={{ width: 640 }}>
      <Table
        aria-label="提供商表格"
        density="compact"
        idKey="provider"
        columns={[
          { key: 'provider', header: 'Provider', width: proportional(1) },
          { key: 'requests', header: 'Requests', align: 'end' },
          { key: 'cost', header: 'Cost', align: 'end' },
        ]}
        data={[
          { provider: 'Anthropic', requests: 280, cost: '$1.50' },
          { provider: 'OpenAI', requests: 140, cost: '$0.84' },
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
      <Table aria-label="请求日志" density="compact" textOverflow="truncate" idKey="id" columns={REQUEST_COLUMNS} data={REQUEST_ROWS} />
    </div>
  ),
};
