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

import type { ComponentPropsWithoutRef } from 'react';

type AppShellDetailPanelProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'className' | 'data-agents-view'
> & {
  agentsView: 'skills' | 'mcp' | 'cron' | 'daily-review' | 'im_hub';
};

export function AppShellDetailPanel({
  agentsView,
  children,
  ...props
}: AppShellDetailPanelProps) {
  return (
    <div
      {...props}
      // No surface class: this frames the plates, it is not one. The content
      // surface is `.mainColumn` inside it — see shell-layout.css.
      className="maka-panel maka-panel-detail"
      data-agents-view={agentsView}
    >
      {children}
    </div>
  );
}
