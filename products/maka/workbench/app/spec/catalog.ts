/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { defineCatalog } from '@json-render/core';
import { standardDirectives } from '@json-render/directives';
import { z } from 'zod';
import { specSchema } from './schema.ts';

const CheckItemSchema = z.object({
  type: z.string(),
  message: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const ChecksSchema = z.array(CheckItemSchema).nullable().optional();

const SelectOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    value: z.string(),
    description: z.string().nullable().optional(),
    disabled: z.boolean().nullable().optional(),
  }),
]);

const ChartSeriesSchema = z.object({
  key: z.string(),
  label: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});

export const specComponentDefinitions = {
  Card: {
    props: z.object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      subtitle: z.string().nullable().optional(),
      padding: z.enum(['none', 'sm', 'md', 'lg']).nullable().optional(),
    }),
    slots: ['default', 'header', 'footer'],
    description:
      'Elevated container grouping related content with optional title, description, and header/footer slots.',
    example: { title: 'Overview', description: 'Live metrics and controls' },
  },

  Text: {
    props: z.object({
      text: z.string(),
      variant: z.enum(['body', 'caption', 'muted', 'lead', 'code']).nullable().optional(),
      color: z
        .enum(['default', 'secondary', 'muted', 'accent', 'success', 'warning', 'danger'])
        .nullable()
        .optional(),
      bold: z.boolean().nullable().optional(),
      italic: z.boolean().nullable().optional(),
      align: z.enum(['left', 'center', 'right']).nullable().optional(),
      truncate: z.boolean().nullable().optional(),
    }),
    slots: [],
    description: 'Body, caption, or inline monospace text.',
    example: { text: 'Summary item' },
  },

  Stack: {
    props: z.object({
      direction: z.enum(['vertical', 'horizontal']).nullable().optional(),
      gap: z
        .union([z.enum(['none', 'xs', 'sm', 'md', 'lg']), z.number()])
        .nullable()
        .optional(),
      align: z.enum(['start', 'center', 'end', 'stretch', 'baseline']).nullable().optional(),
      justify: z.enum(['start', 'center', 'end', 'between', 'around']).nullable().optional(),
      wrap: z.boolean().nullable().optional(),
    }),
    slots: ['default'],
    description: 'Vertical or horizontal flex stack with configurable gap and alignment.',
    example: { direction: 'vertical', gap: 'md' },
  },

  Grid: {
    props: z.object({
      columns: z.number().nullable().optional(),
      gap: z
        .union([z.enum(['none', 'xs', 'sm', 'md', 'lg']), z.number()])
        .nullable()
        .optional(),
    }),
    slots: ['default'],
    description:
      'Multi-column CSS/Taffy grid container (defaults to 2 columns, collapses cleanly on narrow terminals).',
    example: { columns: 3, gap: 'md' },
  },

  Box: {
    props: z.object({
      direction: z.enum(['column', 'row']).nullable().optional(),
      gap: z.number().nullable().optional(),
      padding: z.number().nullable().optional(),
      paddingX: z.number().nullable().optional(),
      paddingY: z.number().nullable().optional(),
      alignItems: z.enum(['flex-start', 'center', 'flex-end', 'stretch']).nullable().optional(),
      justifyContent: z
        .enum(['flex-start', 'center', 'flex-end', 'space-between', 'space-around'])
        .nullable()
        .optional(),
      bordered: z.boolean().nullable().optional(),
      grow: z.number().nullable().optional(),
    }),
    slots: ['default'],
    description: 'Low-level flex container with explicit padding, border, and flex grow.',
    example: { direction: 'row', gap: 8, padding: 12, bordered: true },
  },

  Spacer: {
    props: z.object({
      size: z.number().nullable().optional(),
      flex: z.boolean().nullable().optional(),
    }),
    slots: [],
    description: 'Fixed spacing gap or flexible spring space inside a Stack or Box.',
    example: { flex: true },
  },

  Newline: {
    props: z.object({
      count: z.number().nullable().optional(),
    }),
    slots: [],
    description: 'Vertical line break spacing (count defaults to 1).',
    example: { count: 1 },
  },

  Separator: {
    props: z.object({
      orientation: z.enum(['horizontal', 'vertical']).nullable().optional(),
    }),
    slots: [],
    description: 'Thin visual rule separating sections or inline items.',
    example: { orientation: 'horizontal' },
  },

  Divider: {
    props: z.object({
      title: z.string().nullable().optional(),
      orientation: z.enum(['horizontal', 'vertical']).nullable().optional(),
    }),
    slots: [],
    description: 'Section divider line with an optional centered title label.',
    example: { title: 'Details' },
  },

  Heading: {
    props: z.object({
      text: z.string(),
      level: z.enum(['h1', 'h2', 'h3', 'h4']).nullable().optional(),
    }),
    slots: [],
    description: 'Section heading (h1-h4).',
    example: { text: 'System Health', level: 'h2' },
  },

  Markdown: {
    props: z.object({
      content: z.string(),
    }),
    slots: [],
    description: 'Rich formatted Markdown block (lists, emphasis, inline code, tables).',
    example: { content: '**Note**: Values update automatically as you adjust sliders.' },
  },

  CodeBlock: {
    props: z.object({
      code: z.string(),
      language: z.string().nullable().optional(),
    }),
    slots: [],
    description: 'Syntax-highlighted code block with copy and wrap actions.',
    example: { language: 'json', code: '{\n  "port": 8080\n}' },
  },

  Badge: {
    props: z.object({
      text: z.string(),
      variant: z
        .enum([
          'default',
          'secondary',
          'outline',
          'info',
          'success',
          'warning',
          'danger',
          'destructive',
        ])
        .nullable()
        .optional(),
    }),
    slots: [],
    description: 'Compact status or category pill badge.',
    example: { text: 'Healthy', variant: 'success' },
  },

  StatusLine: {
    props: z.object({
      label: z.string(),
      status: z.enum(['info', 'success', 'warning', 'error', 'pending']).nullable().optional(),
      detail: z.string().nullable().optional(),
    }),
    slots: [],
    description: 'Single-line status indicator with semantic icon, label, and trailing detail.',
    example: { label: 'Build pipeline', status: 'success', detail: '142 passed' },
  },

  Alert: {
    props: z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      type: z
        .enum(['info', 'success', 'warning', 'error', 'default', 'destructive'])
        .nullable()
        .optional(),
    }),
    slots: [],
    description: 'Prominent status banner with title and optional description.',
    example: {
      title: 'Quota warning',
      description: '85% of monthly budget used.',
      type: 'warning',
    },
  },

  Callout: {
    props: z.object({
      type: z.enum(['info', 'tip', 'warning', 'important', 'caution']).nullable().optional(),
      title: z.string().nullable().optional(),
      content: z.string(),
    }),
    slots: [],
    description: 'Highlighted callout block with left accent border for tips, notes, or warnings.',
    example: { type: 'tip', title: 'Tip', content: 'Click any column header to sort rows.' },
  },

  Metric: {
    props: z.object({
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      change: z.string().nullable().optional(),
      trend: z.enum(['up', 'down', 'neutral']).nullable().optional(),
      caption: z.string().nullable().optional(),
      sparkline: z.array(z.number()).nullable().optional(),
    }),
    slots: [],
    description:
      'KPI stat tile displaying a primary value, label, optional delta/trend badge, caption, and mini sparkline.',
    example: {
      label: 'P95 Latency',
      value: '42 ms',
      change: '-12%',
      trend: 'down',
      sparkline: [64, 58, 55, 49, 45, 42],
    },
  },

  KeyValue: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
      items: z
        .array(
          z.object({
            key: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
          }),
        )
        .nullable()
        .optional(),
      striped: z.boolean().nullable().optional(),
    }),
    slots: [],
    description: 'Aligned key-value pair or list of key-value rows.',
    example: {
      items: [
        { key: 'Region', value: 'ap-northeast-1' },
        { key: 'Replicas', value: 3 },
      ],
    },
  },

  Table: {
    props: z.object({
      columns: z.array(
        z.union([
          z.string(),
          z.object({
            key: z.string(),
            header: z.string(),
            align: z.enum(['left', 'center', 'right']).nullable().optional(),
            width: z.number().nullable().optional(),
            sortable: z.boolean().nullable().optional(),
          }),
        ]),
      ),
      rows: z.array(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])),
      caption: z.string().nullable().optional(),
      sortable: z.boolean().nullable().optional(),
      striped: z.boolean().nullable().optional(),
    }),
    slots: [],
    description:
      'Structured data table supporting either string[] columns + 2D rows or {key, header}[] columns + object[] rows, with optional client-side column sorting.',
    example: {
      columns: ['Service', 'Status', 'Latency'],
      rows: [
        ['api-gateway', 'Healthy', '18 ms'],
        ['worker-pool', 'Healthy', '34 ms'],
      ],
      sortable: true,
    },
  },

  List: {
    props: z.object({
      items: z.array(z.string()).nullable().optional(),
      ordered: z.boolean().nullable().optional(),
      divided: z.boolean().nullable().optional(),
    }),
    slots: ['default'],
    description: 'Ordered or bulleted list from string items or ListItem children.',
    example: { items: ['Verify schema', 'Run unit tests', 'Check bundle notices'], ordered: true },
  },

  ListItem: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().nullable().optional(),
      trailing: z.string().nullable().optional(),
      leading: z.string().nullable().optional(),
    }),
    slots: [],
    events: ['press'],
    description:
      'Structured row inside a List with title, optional subtitle, leading marker, and trailing value.',
    example: { title: 'api-gateway', subtitle: '3 instances active', trailing: '99.98%' },
  },

  Timeline: {
    props: z.object({
      items: z.array(
        z.object({
          title: z.string(),
          description: z.string().nullable().optional(),
          time: z.string().nullable().optional(),
          status: z.enum(['completed', 'active', 'pending', 'error']).nullable().optional(),
        }),
      ),
    }),
    slots: [],
    description: 'Vertical chronological timeline of milestones, stages, or events.',
    example: {
      items: [
        { title: 'Build completed', time: '10:01', status: 'completed' },
        {
          title: 'Canary rollout',
          description: '25% traffic shifted',
          time: '10:04',
          status: 'active',
        },
      ],
    },
  },

  Progress: {
    props: z.object({
      value: z.number(),
      max: z.number().nullable().optional(),
      label: z.string().nullable().optional(),
      showValue: z.boolean().nullable().optional(),
      color: z.enum(['accent', 'success', 'warning', 'danger']).nullable().optional(),
    }),
    slots: [],
    description:
      'Horizontal progress bar (0 to max, default 100) with optional label and percentage.',
    example: { label: 'Migration progress', value: 72, max: 100, showValue: true },
  },

  ProgressBar: {
    props: z.object({
      progress: z.number(),
      total: z.number().nullable().optional(),
      label: z.string().nullable().optional(),
      color: z.enum(['accent', 'success', 'warning', 'danger']).nullable().optional(),
    }),
    slots: [],
    description:
      'Alias progress indicator supporting fraction (0..1 when total omitted and progress <= 1) or progress/total.',
    example: { label: 'Indexing', progress: 65, total: 100 },
  },

  LineChart: {
    props: z.object({
      title: z.string().nullable().optional(),
      data: z.array(z.record(z.string(), z.unknown())),
      xKey: z.string(),
      series: z.array(ChartSeriesSchema),
      height: z.number().nullable().optional(),
      curve: z.enum(['linear', 'monotone', 'step']).nullable().optional(),
      dots: z.boolean().nullable().optional(),
      grid: z.boolean().nullable().optional(),
    }),
    slots: [],
    description:
      'Native GPU/Braille multi-series line chart. Provide data rows, xKey for x-axis labels/numbers, and series [{ key, label?, color? }].',
    example: {
      title: 'Requests / sec',
      xKey: 'time',
      series: [{ key: 'rps', label: 'RPS' }],
      data: [
        { time: '00:00', rps: 120 },
        { time: '06:00', rps: 180 },
        { time: '12:00', rps: 310 },
      ],
    },
  },

  AreaChart: {
    props: z.object({
      title: z.string().nullable().optional(),
      data: z.array(z.record(z.string(), z.unknown())),
      xKey: z.string(),
      series: z.array(ChartSeriesSchema),
      height: z.number().nullable().optional(),
      curve: z.enum(['linear', 'monotone', 'step']).nullable().optional(),
      stacked: z.boolean().nullable().optional(),
    }),
    slots: [],
    description:
      'Native GPU/Braille filled area chart supporting single, multi-series, or stacked series.',
    example: {
      title: 'Memory Usage (MB)',
      xKey: 'step',
      series: [{ key: 'heap', label: 'Heap' }],
      data: [
        { step: 'T1', heap: 240 },
        { step: 'T2', heap: 310 },
        { step: 'T3', heap: 285 },
      ],
    },
  },

  BarChart: {
    props: z.object({
      title: z.string().nullable().optional(),
      data: z.array(z.record(z.string(), z.unknown())),
      xKey: z.string().nullable().optional(),
      series: z.array(ChartSeriesSchema).nullable().optional(),
      stacked: z.boolean().nullable().optional(),
      height: z.number().nullable().optional(),
      showValues: z.boolean().nullable().optional(),
    }),
    slots: [],
    description:
      'Native bar chart. Accepts either simple [{ label, value, color? }] data or multi-series data with xKey and series [{ key, label?, color? }].',
    example: {
      title: 'Latency by Tier (ms)',
      data: [
        { label: 'Cache', value: 4 },
        { label: 'DB', value: 19 },
        { label: 'Search', value: 37 },
      ],
    },
  },

  PieChart: {
    props: z.object({
      title: z.string().nullable().optional(),
      data: z.array(
        z.object({
          label: z.string(),
          value: z.number(),
          color: z.string().nullable().optional(),
        }),
      ),
      donut: z.boolean().nullable().optional(),
      height: z.number().nullable().optional(),
    }),
    slots: [],
    description: 'Native pie or donut chart with automatic legend and percentage breakdown.',
    example: {
      title: 'Token Breakdown',
      donut: true,
      data: [
        { label: 'Input', value: 68 },
        { label: 'Cached', value: 22 },
        { label: 'Output', value: 10 },
      ],
    },
  },

  ScatterChart: {
    props: z.object({
      title: z.string().nullable().optional(),
      data: z.array(z.record(z.string(), z.unknown())),
      xKey: z.string(),
      yKey: z.string(),
      labelKey: z.string().nullable().optional(),
      sizeKey: z.string().nullable().optional(),
      height: z.number().nullable().optional(),
    }),
    slots: [],
    description: '2D scatter or bubble plot for numeric xKey and yKey coordinates.',
    example: {
      title: 'Cost vs Accuracy',
      xKey: 'cost',
      yKey: 'score',
      data: [
        { cost: 1.2, score: 84 },
        { cost: 3.5, score: 92 },
        { cost: 6.0, score: 95 },
      ],
    },
  },

  Heatmap: {
    props: z.object({
      title: z.string().nullable().optional(),
      xLabels: z.array(z.string()),
      yLabels: z.array(z.string()),
      values: z.array(z.array(z.number())),
      height: z.number().nullable().optional(),
    }),
    slots: [],
    description: '2D matrix heatmap where values[row][col] maps to yLabels[row] and xLabels[col].',
    example: {
      title: 'Error Rate (%)',
      xLabels: ['Mon', 'Tue', 'Wed'],
      yLabels: ['API', 'Worker'],
      values: [
        [0.1, 0.2, 0.1],
        [0.4, 1.2, 0.3],
      ],
    },
  },

  Sparkline: {
    props: z.object({
      data: z.array(z.number()),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      color: z.enum(['accent', 'success', 'warning', 'danger', 'muted']).nullable().optional(),
      label: z.string().nullable().optional(),
    }),
    slots: [],
    description: 'Compact inline trend sparkline for an array of numbers.',
    example: { data: [12, 15, 13, 19, 24, 22, 29], color: 'accent' },
  },

  Tabs: {
    props: z.object({
      tabs: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          content: z.string().nullable().optional(),
        }),
      ),
      defaultValue: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
    }),
    slots: ['default'],
    events: ['change'],
    description:
      'Tabbed navigation container. Bind value with { "$bindState": "/tab" } and place TabContent children (or named slots matching tab value, or inline tab.content).',
    example: {
      defaultValue: 'summary',
      tabs: [
        { label: 'Summary', value: 'summary' },
        { label: 'Logs', value: 'logs' },
      ],
    },
  },

  TabContent: {
    props: z.object({
      value: z.string(),
    }),
    slots: ['default'],
    description: 'Content panel inside Tabs shown only when its value matches the active tab.',
    example: { value: 'summary' },
  },

  Accordion: {
    props: z.object({
      items: z.array(
        z.object({
          title: z.string(),
          content: z.string(),
          value: z.string().nullable().optional(),
        }),
      ),
      type: z.enum(['single', 'multiple']).nullable().optional(),
      defaultOpen: z.array(z.number()).nullable().optional(),
    }),
    slots: [],
    description: 'Expandable accordion sections with title and content.',
    example: {
      type: 'single',
      items: [
        { title: 'Root cause', content: 'Connection pool saturated during batch import.' },
        { title: 'Mitigation', content: 'Cap batch concurrency at 8 workers.' },
      ],
    },
  },

  Collapsible: {
    props: z.object({
      title: z.string(),
      defaultOpen: z.boolean().nullable().optional(),
      open: z.boolean().nullable().optional(),
    }),
    slots: ['default'],
    events: ['change'],
    description: 'Disclosure container that folds and unfolds its child elements.',
    example: { title: 'Advanced options', defaultOpen: false },
  },

  Dialog: {
    props: z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      openPath: z.string(),
    }),
    slots: ['default'],
    description:
      'Modal dialog controlled by boolean state at openPath (JSON Pointer, e.g. "/dialogOpen"). Open via a Button setting openPath to true.',
    example: { title: 'Inspect Payload', description: 'Raw event fields', openPath: '/dialogOpen' },
  },

  Drawer: {
    props: z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      openPath: z.string(),
    }),
    slots: ['default'],
    description:
      'Sheet overlay controlled by boolean state at openPath (JSON Pointer, e.g. "/drawerOpen").',
    example: { title: 'Filter Details', openPath: '/drawerOpen' },
  },

  Popover: {
    props: z.object({
      trigger: z.string(),
      content: z.string().nullable().optional(),
    }),
    slots: ['default'],
    description: 'Anchored popover button showing text content or child elements when pressed.',
    example: {
      trigger: 'Explain formula',
      content: 'Weighted harmonic mean across active shards.',
    },
  },

  Tooltip: {
    props: z.object({
      content: z.string(),
      text: z.string().nullable().optional(),
    }),
    slots: ['default'],
    description: 'Hover/focus hint attached to a text label or child element.',
    example: { text: 'SLO 99.9%', content: 'Rolling 30-day availability target' },
  },

  Carousel: {
    props: z.object({
      items: z
        .array(
          z.object({
            title: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
    }),
    slots: ['default'],
    description:
      'Paged slide switcher stepping through items or child elements with Previous/Next controls.',
    example: {
      items: [
        { title: 'Step 1', description: 'Prepare configuration' },
        { title: 'Step 2', description: 'Verify dry-run output' },
      ],
    },
  },

  Image: {
    props: z.object({
      src: z.string().nullable().optional(),
      alt: z.string(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
    }),
    slots: [],
    description: 'Image with alt label and graceful fallback frame when offline or in terminal.',
    example: { alt: 'Architecture diagram', width: 320, height: 180 },
  },

  Avatar: {
    props: z.object({
      name: z.string(),
      src: z.string().nullable().optional(),
      size: z.enum(['sm', 'md', 'lg']).nullable().optional(),
    }),
    slots: [],
    description: 'Initials badge (or image) representing a person or service.',
    example: { name: 'Ada Lovelace', size: 'md' },
  },

  Skeleton: {
    props: z.object({
      lines: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
    }),
    slots: [],
    description: 'Placeholder block indicating pending layout regions.',
    example: { lines: 3 },
  },

  Spinner: {
    props: z.object({
      label: z.string().nullable().optional(),
    }),
    slots: [],
    description: 'Compact activity indicator with optional label.',
    example: { label: 'Computing projection…' },
  },

  EmptyState: {
    props: z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
    }),
    slots: ['default'],
    description:
      'Centered empty-state placeholder with title, optional description, and optional action children.',
    example: { title: 'No matching records', description: 'Try clearing active filters.' },
  },

  Input: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      placeholder: z.string().nullable().optional(),
      type: z.enum(['text', 'email', 'password', 'number', 'url', 'search']).nullable().optional(),
      helperText: z.string().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
      validateOn: z.enum(['change', 'blur', 'submit']).nullable().optional(),
    }),
    slots: [],
    events: ['change', 'blur', 'submit'],
    description:
      'Single-line text input. Bind value via { "$bindState": "/path" } or { "$bindItem": "field" }.',
    example: { label: 'Filter host', placeholder: 'api-prod-*', value: '' },
  },

  TextInput: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      placeholder: z.string().nullable().optional(),
      masked: z.boolean().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
      validateOn: z.enum(['change', 'blur', 'submit']).nullable().optional(),
    }),
    slots: [],
    events: ['change', 'blur', 'submit'],
    description: 'Single-line text field alias compatible with terminal/ink specs.',
    example: { label: 'Query', placeholder: 'status:open' },
  },

  Textarea: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      placeholder: z.string().nullable().optional(),
      rows: z.number().nullable().optional(),
      helperText: z.string().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
      validateOn: z.enum(['change', 'blur', 'submit']).nullable().optional(),
    }),
    slots: [],
    events: ['change', 'blur'],
    description: 'Multi-line text editor bound via { "$bindState": "/path" }.',
    example: { label: 'Notes', placeholder: 'Enter observations…', rows: 3 },
  },

  NumberInput: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.number().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      step: z.number().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
    }),
    slots: [],
    events: ['change'],
    description: 'Numeric field with decrement/increment buttons and min/max/step clamping.',
    example: { label: 'Worker count', value: 4, min: 1, max: 32, step: 1 },
  },

  Select: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      options: z.array(SelectOptionSchema),
      placeholder: z.string().nullable().optional(),
      helperText: z.string().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
    }),
    slots: [],
    events: ['change'],
    description:
      'Dropdown selector accepting string[] or { label, value, description? }[] options. Bind value with { "$bindState": "/path" }.',
    example: {
      label: 'Environment',
      options: ['production', 'staging', 'development'],
      value: 'production',
    },
  },

  MultiSelect: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.array(z.string()).nullable().optional(),
      options: z.array(SelectOptionSchema),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
    }),
    slots: [],
    events: ['change'],
    description: 'Multi-option selector toggling values inside a bound string[] state array.',
    example: {
      label: 'Regions',
      options: ['us-east', 'eu-west', 'ap-northeast'],
      value: ['us-east'],
    },
  },

  Checkbox: {
    props: z.object({
      label: z.string(),
      description: z.string().nullable().optional(),
      checked: z.boolean().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
    }),
    slots: [],
    events: ['change'],
    description:
      'Boolean checkbox control. Bind checked with { "$bindState": "/path" } or { "$bindItem": "done" }.',
    example: { label: 'Include archived records', checked: false },
  },

  Radio: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.string().nullable().optional(),
      options: z.array(SelectOptionSchema),
      direction: z.enum(['vertical', 'horizontal']).nullable().optional(),
      disabled: z.boolean().nullable().optional(),
      checks: ChecksSchema,
    }),
    slots: [],
    events: ['change'],
    description: 'Exclusive radio group bound via { "$bindState": "/path" }.',
    example: {
      label: 'Billing cycle',
      options: [
        { label: 'Monthly', value: 'monthly' },
        { label: 'Annual (save 20%)', value: 'annual' },
      ],
      value: 'monthly',
    },
  },

  Switch: {
    props: z.object({
      label: z.string(),
      description: z.string().nullable().optional(),
      checked: z.boolean().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
    }),
    slots: [],
    events: ['change'],
    description: 'Immediate on/off toggle row. Bind checked with { "$bindState": "/path" }.',
    example: { label: 'Auto-refresh preview', checked: true },
  },

  Slider: {
    props: z.object({
      label: z.string().nullable().optional(),
      value: z.number().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      step: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
    }),
    slots: [],
    events: ['change'],
    description:
      'Interactive range slider with live value readout. Bind value with { "$bindState": "/path" }.',
    example: { label: 'Concurrency', min: 1, max: 64, step: 1, value: 16 },
  },

  Button: {
    props: z.object({
      label: z.string(),
      variant: z.enum(['primary', 'secondary', 'outline', 'ghost', 'danger']).nullable().optional(),
      size: z.enum(['sm', 'md']).nullable().optional(),
      disabled: z.boolean().nullable().optional(),
    }),
    slots: [],
    events: ['press'],
    description:
      'Action button triggering client actions on press (setState, pushState, resetState, validateForm, copyText).',
    example: { label: 'Reset defaults', variant: 'secondary' },
  },

  ButtonGroup: {
    props: z.object({
      buttons: z
        .array(
          z.object({
            label: z.string(),
            value: z.string(),
            disabled: z.boolean().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
      selected: z.string().nullable().optional(),
    }),
    slots: ['default'],
    events: ['change'],
    description:
      'Segmented button row either from buttons[] bound via selected or from Button children.',
    example: {
      selected: '7d',
      buttons: [
        { label: '24h', value: '24h' },
        { label: '7d', value: '7d' },
        { label: '30d', value: '30d' },
      ],
    },
  },

  Toggle: {
    props: z.object({
      label: z.string(),
      pressed: z.boolean().nullable().optional(),
      disabled: z.boolean().nullable().optional(),
    }),
    slots: [],
    events: ['change'],
    description: 'Two-state pressed toggle button. Bind pressed with { "$bindState": "/path" }.',
    example: { label: 'Show outliers', pressed: false },
  },

  ToggleGroup: {
    props: z.object({
      items: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
        }),
      ),
      type: z.enum(['single', 'multiple']).nullable().optional(),
      value: z
        .union([z.string(), z.array(z.string())])
        .nullable()
        .optional(),
    }),
    slots: [],
    events: ['change'],
    description:
      'Single or multi-value segmented toggle group. Bind value with { "$bindState": "/path" }.',
    example: {
      type: 'single',
      value: 'table',
      items: [
        { label: 'Table', value: 'table' },
        { label: 'Chart', value: 'chart' },
      ],
    },
  },

  DropdownMenu: {
    props: z.object({
      label: z.string(),
      value: z.string().nullable().optional(),
      items: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          disabled: z.boolean().nullable().optional(),
        }),
      ),
    }),
    slots: [],
    events: ['select'],
    description:
      'Popover action menu writing the chosen item value to bound value or firing on.select.',
    example: {
      label: 'Preset',
      items: [
        { label: 'Conservative', value: 'conservative' },
        { label: 'Balanced', value: 'balanced' },
        { label: 'Aggressive', value: 'aggressive' },
      ],
    },
  },

  Pagination: {
    props: z.object({
      page: z.number().nullable().optional(),
      totalPages: z.number(),
    }),
    slots: [],
    events: ['change'],
    description: 'Page navigator (1..totalPages). Bind page with { "$bindState": "/page" }.',
    example: { page: 1, totalPages: 5 },
  },

  ConfirmInput: {
    props: z.object({
      message: z.string(),
      confirmLabel: z.string().nullable().optional(),
      cancelLabel: z.string().nullable().optional(),
      value: z.boolean().nullable().optional(),
    }),
    slots: [],
    events: ['confirm', 'cancel'],
    description:
      'Inline Yes/No confirmation prompt updating bound boolean value and firing confirm/cancel events.',
    example: {
      message: 'Include experimental benchmarks?',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    },
  },

  Link: {
    props: z.object({
      label: z.string(),
      href: z.string(),
    }),
    slots: [],
    events: ['press'],
    description:
      'External link opened through the workbench link handler (or firing client press actions).',
    example: { label: 'Apache License 2.0', href: 'https://www.apache.org/licenses/LICENSE-2.0' },
  },
};

export const specCatalog = defineCatalog(specSchema, {
  components: specComponentDefinitions,
});

export function buildSpecCatalogPrompt(): string {
  const raw = specCatalog.prompt({
    system:
      'Maka natively renders inline ```spec code blocks inside conversation messages using the catalog and rules below.',
    mode: 'inline',
    directives: standardDirectives,
    customRules: [
      'Prefer interactive client state ($bindState, Slider, Tabs, Select, Switch, Table sorting) over static prose when the user is comparing trade-offs, exploring parameters, inspecting structured metrics, or filling a calculator/checklist.',
      'Do NOT emit ```spec blocks for plain text answers, simple 2-row tables, or flowcharts/sequence diagrams (use ```mermaid for architecture/sequence diagrams, and ```spec for data charts, dashboards, metrics, and interactive UI).',
    ],
  });

  return raw
    .replace(
      'Example (cascading select \u2014 country changes trigger city loading):',
      'Example (cascading select \u2014 country changes reset dependent city selection):',
    )
    .replace(
      '{"action":"loadCities","params":{"country":{"$state":"/form/country"}}}',
      '{"action":"setState","params":{"statePath":"/form/city","value":""}}',
    )
    .replace(
      '(loading data, resetting dependent fields, computing derived values)',
      '(resetting dependent fields, clearing stale selections, updating client state)',
    );
}
