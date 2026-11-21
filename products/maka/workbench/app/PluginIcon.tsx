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

import { Image, View } from 'nsh';
import type { QuickEntry } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Icon } from './Icon';
import { MakaMark } from './QuickBar';
import { C } from './ui';

type Mark = Parameters<typeof Icon>[0]['name'] | 'maka';

// Package identities persist even when a plugin is disabled and its commands are unmounted.
const packageMarks: Readonly<Partial<Record<string, Mark>>> = {
  'maka.workbench': 'maka',
  'maka.conversations': 'maka',
  'maka.composer': 'edit',
  'maka.applications': 'app',
  'maka.calculator': 'calculator',
  'maka.clipboard-history': 'clipboard',
  'maka.dictation': 'mic',
  'maka.symbols': 'symbol',
  'maka.quick-library': 'folder',
  'maka.file-search': 'file',
  'maka.screenshot': 'camera',
  'maka.agent.agent': 'bot',
  'maka.agent.acp-executor': 'terminal',
  'maka.agent.gateway': 'link',
  'maka.agent.deployment-gateway': 'link',
  'maka.agent.recovery-gateway': 'refresh',
  'maka.agent.host-deployment-manager': 'settings',
  'maka.application.host-logs': 'text',
  'maka.agent.settings': 'settings',
  'maka.agent.settings-authentication': 'lock',
  'maka.agent.settings-setup': 'settings',
  'maka.agent.forms': 'clipboard',
  'maka.agent.questions': 'conversation',
  'maka.agent.receipts': 'check',
  'maka.agent.skills': 'archive',
  'maka.agent.workspace-files': 'folder',
  'maka.agent.workspace-web': 'globe',
  'maka.agent.workspace-computer': 'inspector',
  'maka.agent.workspace-processes': 'terminal',
  'maka.agent.protocol-processes': 'code',
  'maka.agent.workspace-decisions-api': 'approval',
};
const libraryMarks: Readonly<Partial<Record<string, Mark>>> = {
  links: 'link',
  notes: 'note',
  snippets: 'snippet',
};

export function PluginIcon(props: {
  packageId: string;
  toolId?: string;
  entry?: QuickEntry | undefined;
  muted: boolean;
}) {
  const name = () =>
    props.entry?.icon ??
    (props.packageId === 'maka.quick-library' && props.toolId
      ? libraryMarks[props.toolId]
      : undefined) ??
    packageMarks[props.packageId] ??
    'app';
  const image = () => props.entry?.image?.();
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          width: 20,
          height: 20,
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: props.muted ? 0.5 : 1,
        },
        { pointerEvents: 'none' },
      ]}
    >
      <If
        when={!!image()}
        else={
          <If
            when={name() === 'maka'}
            else={<Icon name={name() as Exclude<Mark, 'maka'>} size={16} color={C.secondary} />}
          >
            <MakaMark />
          </If>
        }
      >
        <Image src={image()!} style={{ width: 18, height: 18, objectFit: 'contain' }} />
      </If>
    </View>
  );
}
