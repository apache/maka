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

// packages/ui/src/primitives/stat-tile.tsx
//
// The "big number + label (+ detail)" stat tile. One shape, no variants: a
// hairline card at surface radius holding three lines — the label, the value
// (tabular-nums ALWAYS, per the tabular-nums-converge contract) and an optional
// detail. Settings' MetricCard (`settings-metric-card.tsx`) is its only
// consumer.
//
// Styled with package-owned semantic classes; wrapper classes from the call
// site (grid placement, page pins) pass through.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Optional third quiet line under the label (MetricCard's detail). */
  detail?: ReactNode;
  className?: string;
}

export function StatTile({ label, value, detail, className }: StatTileProps) {
  return (
    <div className={cn('maka-stat-tile', className)} data-slot="stat-tile">
      <span className="maka-stat-tile-value" data-slot="stat-tile-value">
        {value}
      </span>
      <span
        className="maka-stat-tile-label"
        data-slot="stat-tile-label"
      >
        {label}
      </span>
      {detail != null && (
        <span
          className="maka-stat-tile-detail"
          data-slot="stat-tile-detail"
        >
          {detail}
        </span>
      )}
    </div>
  );
}
