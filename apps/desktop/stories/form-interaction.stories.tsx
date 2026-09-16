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

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { FormRequestEvent } from '@maka/core/events';
import { FormInteractionPrompt } from '@maka/ui';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.
const meta = {
  title: 'Product/Form Interaction',
  component: FormInteractionPrompt,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div
        className="maka-panel maka-panel-detail"
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="maka-detail-with-artifacts">
          <div className="mainColumn" style={{ justifyContent: 'flex-end' }}>
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof FormInteractionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

const REQUEST: FormRequestEvent = {
  type: 'form_request',
  id: 'form-event',
  ts: Date.now(),
  turnId: 'form-turn',
  requestId: 'form-request',
  toolUseId: 'form-tool',
  message: '配置生产环境发布',
  requester: { name: 'create_release', source: 'Acme Deploy MCP' },
  fields: [
    {
      kind: 'string',
      name: 'version',
      label: '版本号',
      description: '将显示在发布记录和通知中。',
      required: true,
      default: 'v2.4.0',
      minLength: 2,
    },
    {
      kind: 'integer',
      name: 'replicas',
      label: '实例数量',
      required: true,
      default: 3,
      minimum: 1,
      maximum: 20,
    },
    {
      kind: 'single_select',
      name: 'channel',
      label: '发布通道',
      required: true,
      default: 'stable',
      options: [
        { value: 'stable', label: 'Stable' },
        { value: 'canary', label: 'Canary' },
      ],
    },
    {
      kind: 'boolean',
      name: 'notify',
      label: '发送发布通知',
      description: '可选；启用后通知项目成员。',
      required: false,
    },
  ],
};

// Real path: a running tool requests structured input → Runtime Host parks the
// exact invocation → Desktop replaces the composer with this form. Accept,
// Decline, and Cancel all answer that same Host-owned interaction.
export const PendingDeploymentForm: Story = {
  args: { request: REQUEST, onRespond: () => {} },
};
