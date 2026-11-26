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

import { tr } from '../../locale';
import type { IconName } from '../../ui';

export type HostSettingDomain =
  | 'general'
  | 'models'
  | 'subagents'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'web_search'
  | 'network';

interface DomainMeta {
  title: () => string;
  icon: IconName;
  endpoint: string;
}

export const HOST_SETTING_DOMAINS: Record<HostSettingDomain, DomainMeta> = {
  general: {
    title: () => tr('General'),
    icon: 'sliders',
    endpoint: 'settings',
  },
  models: {
    title: () => tr('Models & Connections'),
    icon: 'sparkles',
    endpoint: 'settings',
  },
  subagents: {
    title: () => tr('Subagents'),
    icon: 'users',
    endpoint: 'agent',
  },
  plugins: {
    title: () => tr('Plugins'),
    icon: 'puzzle',
    endpoint: 'management',
  },
  mcp: {
    title: () => tr('MCP'),
    icon: 'plug',
    endpoint: 'agent',
  },
  skills: {
    title: () => tr('Skills'),
    icon: 'book',
    endpoint: 'skills',
  },
  web_search: {
    title: () => tr('Web Search'),
    icon: 'globe',
    endpoint: 'web',
  },
  network: {
    title: () => tr('Network Proxy'),
    icon: 'network',
    endpoint: 'settings',
  },
};
