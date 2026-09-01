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
// The shared implementation for "big number + label (+ detail)" stat tiles. Before
// this, four near-identical recipes lived in page CSS (permission summary,
// health summary — literal twins — plus the filled MetricCard and the
// daily-review totals cell).
//
// One shape, no variants. The value is tabular-nums ALWAYS (tabular-nums-converge
// contract); the tile is a hairline card at surface radius; the label and detail
// are supporting copy in muted ink.
//
// It used to carry `tone` (five values, painting the value ink and tinting the
// border), `emphasis` (outline vs a filled compact plate), `zeroNeutral` and
// `as`. Every one of them was reachable only from this package's own story: the
// product has exactly one call site, `settings-metric-card.tsx`, and it passes
// label, value and detail. The tinted borders were the worst of it — 0.24 alpha
// on an untinted plate measures about 1.2:1 in light, so the four tones drew a
// border the reader cannot see and a value colour that said the same thing
// louder. A prop nobody sets is not an extension point; it is four rendering
// paths nobody checks.
//
// Styled with package-owned semantic classes so the primitive is portable; wrapper
// classes from call sites (grid placement, page pins) pass through.

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
