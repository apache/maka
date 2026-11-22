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

export const SPEC_COMPONENT_NAMES = [
  'Card',
  'Text',
  'Stack',
  'Grid',
  'Box',
  'Spacer',
  'Newline',
  'Separator',
  'Divider',
  'Heading',
  'Markdown',
  'CodeBlock',
  'Badge',
  'StatusLine',
  'Alert',
  'Callout',
  'Metric',
  'KeyValue',
  'Table',
  'List',
  'ListItem',
  'Timeline',
  'Progress',
  'ProgressBar',
  'LineChart',
  'AreaChart',
  'BarChart',
  'PieChart',
  'ScatterChart',
  'Heatmap',
  'Sparkline',
  'Tabs',
  'TabContent',
  'Accordion',
  'Collapsible',
  'Dialog',
  'Drawer',
  'Popover',
  'Tooltip',
  'Carousel',
  'Image',
  'Avatar',
  'Skeleton',
  'Spinner',
  'EmptyState',
  'Input',
  'TextInput',
  'Textarea',
  'NumberInput',
  'Select',
  'MultiSelect',
  'Checkbox',
  'Radio',
  'Switch',
  'Slider',
  'Button',
  'ButtonGroup',
  'Toggle',
  'ToggleGroup',
  'DropdownMenu',
  'Pagination',
  'ConfirmInput',
  'Link',
] as const;

export type SpecComponentName = (typeof SPEC_COMPONENT_NAMES)[number];

export const knownSpecComponentTypes: ReadonlySet<string> = new Set<string>(SPEC_COMPONENT_NAMES);
