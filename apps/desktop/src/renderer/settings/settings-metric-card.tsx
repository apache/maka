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

import { StatTile } from '@maka/ui';

/** Thin alias over the shared StatTile (convergence R4) — usage/bot call
 *  sites keep their name; the recipe lives in the primitive. */
export function MetricCard(props: { title: string; value: string; detail?: string }) {
  return (
    /* Detail audit: was emphasis="filled" — gray-plate tiles while the
       Permission/Health summaries use the outlined StatTile. One tile
       language across every settings summary strip. */
    <StatTile
      className="settingsMetricCard"
      label={props.title}
      value={props.value}
      detail={props.detail}
    />
  );
}

// Segmented controls are owned directly by Astryx.
// (the retired local segmented-control implementation). PR yuejing/settings-segmented-primitive
// (WAWQAQ msg `f1461d30` 用库的应该用库).

/**
 * PR-USE-SHADCN-BASE-UI-BADGE — map the project's status-tone vocabulary
 * (success / warning / destructive / info / neutral) onto the canonical
 * shadcn `PrimitiveBadge` variants. `neutral` falls back to `secondary`
 * which is the closest "muted chip" appearance the Badge primitive ships.
 */
