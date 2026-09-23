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

import type { HTMLAttributes } from 'react';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Tooltip } from '@astryxdesign/core/Tooltip';

/**
 * The status-dot slot's "work is in progress" state.
 *
 * The label is text, not the Spinner's `role="status"`: a list of running rows
 * would otherwise be a list of live regions.
 */
export function RunningIndicator({
  label,
  tooltip,
  ...rest
}: { label: string; tooltip?: string } & HTMLAttributes<HTMLSpanElement>) {
  const indicator = (
    <span {...rest} className="maka-running-indicator">
      <Spinner size="sm" aria-hidden="true" />
      <span className="maka-visually-hidden">{label}</span>
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{indicator}</Tooltip> : indicator;
}
