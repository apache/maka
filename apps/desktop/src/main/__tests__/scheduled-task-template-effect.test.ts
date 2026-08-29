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

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveScheduledTaskAgentRunTemplate } from '../../renderer/scheduled-task-template-effect.js';

const template = {
  projectPath: '/workspace/default',
  projectId: 'project-default',
  model: {
    llmConnectionId: 'connection-default',
    llmConnectionSlug: 'default',
    model: 'model-default',
  },
  permissionMode: 'ask' as const,
  collaborationMode: 'agent' as const,
  orchestrationMode: 'default' as const,
};

test('Scheduled Task Agent binding only uses a default-Host Task Entry snapshot', () => {
  assert.deepEqual(
    resolveScheduledTaskAgentRunTemplate({ usesDefaultHost: true, ...template }),
    {
      kind: 'agent_run',
      execution: {
        cwd: '/workspace/default',
        projectId: 'project-default',
        llmConnectionId: 'connection-default',
        llmConnectionSlug: 'default',
        model: 'model-default',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    },
  );

  assert.equal(
    resolveScheduledTaskAgentRunTemplate({ usesDefaultHost: false, ...template }),
    undefined,
  );
});
