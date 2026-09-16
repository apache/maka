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

import { useUiLocale } from '@maka/ui';
import { ChevronLeft, ChevronRight } from '@maka/ui/icons';
import { getShellCopy } from '../../../locales/shell-copy';

/** An edge affordance shared by the collapsed and expanded workspace. */
export function WorkbarEdgeToggle(props: { collapsed: boolean; onToggle(): void }) {
  const copy = getShellCopy(useUiLocale()).chrome;
  const label = props.collapsed ? copy.expandWorkbar : copy.collapseWorkbar;
  const Arrow = props.collapsed ? ChevronLeft : ChevronRight;
  return (
    <button type="button" className="maka-workbar-edge" data-collapsed={props.collapsed || undefined}
      aria-label={label} aria-expanded={!props.collapsed} onClick={props.onToggle}>
      <span className="maka-workbar-edge-glass" aria-hidden="true"><Arrow size={12} /></span>
    </button>
  );
}
