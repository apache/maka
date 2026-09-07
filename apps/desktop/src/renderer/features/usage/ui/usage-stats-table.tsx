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

import type { ReactNode } from 'react';
import {
  Card,
  EmptyState,
  Table,
  type TableColumn,
  type TablePlugin,
  pixel,
  proportional,
} from '@astryxdesign/core';
import type { LucideIcon } from '@maka/ui/icons';

// Feature-owned copy of the shared Usage table recipe (#4425). Astryx Table owns
// geometry/scrolling/dividers/density/cell semantics; every Usage tab maps its
// product rows and empty-state copy into this recipe. External-only deps so the
// feature zone carries no legacy import.

export interface UsageColumn {
  header: string;
  numeric?: boolean;
  grow?: boolean;
  width?: number;
}

type UsageTableRow = Record<string, unknown> & { id: number };

function usageCellNeedsCustomRenderer(value: ReactNode) {
  return (
    value !== null &&
    value !== undefined &&
    !['string', 'number', 'boolean', 'bigint'].includes(typeof value)
  );
}

const usageTablePlugins = {
  cellSemantics: {
    transformBodyCell: (cell, column, _row, columnIndex) => ({
      ...cell,
      htmlProps: {
        ...cell.htmlProps,
        ...(columnIndex === 0 ? { role: 'rowheader' as const } : {}),
        ...(column.align === 'end'
          ? {
              className: [cell.htmlProps.className, 'settingsUsageNumericCell']
                .filter(Boolean)
                .join(' '),
            }
          : {}),
      },
    }),
  },
} satisfies Record<string, TablePlugin<UsageTableRow>>;

export interface UsageEmpty {
  /** A lucide icon (same shape EmptyState accepts). */
  Icon: LucideIcon;
  title: string;
  body?: string;
  /** Tier-3 single action (DESIGN.md §10) — e.g. a filter empty's clear button. */
  action?: ReactNode;
}

export function UsageStatsTable(props: {
  ariaLabel: string;
  columns: UsageColumn[];
  rows: Array<Array<ReactNode>>;
  empty: UsageEmpty;
}) {
  if (props.rows.length === 0) {
    return (
      <EmptyState
        icon={<props.empty.Icon />}
        title={props.empty.title}
        description={props.empty.body ?? undefined}
        actions={props.empty.action}
        className="settingsUsageEmpty"
      />
    );
  }
  const data: UsageTableRow[] = props.rows.map((cells, id) => ({
    id,
    ...Object.fromEntries(cells.map((cell, index) => [`cell-${index}`, cell])),
  }));
  const columns: Array<TableColumn<UsageTableRow>> = props.columns.map((column, index) => {
    const key = `cell-${index}`;
    const needsCustomRenderer = props.rows.some((row) => usageCellNeedsCustomRenderer(row[index]));
    return {
      key,
      header: column.header,
      align: column.numeric ? 'end' : 'start',
      width:
        column.width !== undefined
          ? pixel(column.width)
          : column.grow
            ? proportional(1)
            : pixel(column.numeric ? 88 : 120),
      ...(needsCustomRenderer ? { renderCell: (row) => row[key] as ReactNode } : {}),
    };
  });

  return (
    <Card className="settingsUsageTable" padding={3}>
      <Table
        aria-label={props.ariaLabel}
        data={data}
        columns={columns}
        idKey="id"
        density="compact"
        dividers="rows"
        textOverflow="truncate"
        plugins={usageTablePlugins}
      />
    </Card>
  );
}
