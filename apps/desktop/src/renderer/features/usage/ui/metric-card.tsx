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

/** Thin alias over the shared StatTile — feature-local copy of the settings
 *  MetricCard so the Usage feature carries no legacy import (#4425). */
export function MetricCard(props: { title: string; value: string; detail?: string }) {
  return (
    /* One tile language across every settings summary strip: this used to ask
       for a gray-plate variant while the Permission/Health summaries used the
       outlined one. StatTile has no variants left to disagree about. */
    <StatTile
      className="settingsMetricCard"
      label={props.title}
      value={props.value}
      detail={props.detail}
    />
  );
}
