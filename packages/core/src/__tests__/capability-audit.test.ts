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
import { describe, it } from 'node:test';
import { deriveCapabilityAuditReport } from '../capability-audit.js';
import type { ScheduledTask, ScheduledTaskStatus } from '../scheduled-task.js';

describe('capability audit facts', () => {
  it('reports skill tools and scheduled-task statuses without permission-mode aliases', () => {
    const report = deriveCapabilityAuditReport({
      now: 1_000,
      skills: [
        { id: 'with-tools', name: 'With tools', declaredTools: ['read', 'write'] },
        { id: 'without-tools', name: 'Without tools' },
      ],
      scheduledTasks: [
        scheduledTask('active'),
        scheduledTask('paused'),
        scheduledTask('completed'),
        scheduledTask('expired'),
      ],
    });

    assert.deepEqual(
      report.skills.map(({ id, hasDeclaredTools }) => ({ id, hasDeclaredTools })),
      [
        { id: 'with-tools', hasDeclaredTools: true },
        { id: 'without-tools', hasDeclaredTools: false },
      ],
    );
    assert.equal(
      report.skills.some((skill) => 'permissionMode' in skill),
      false,
    );
    assert.deepEqual(
      report.scheduledTasks.map(({ id, status }) => ({ id, status })),
      [
        { id: 'active', status: 'active' },
        { id: 'paused', status: 'paused' },
        { id: 'completed', status: 'completed' },
        { id: 'expired', status: 'expired' },
      ],
    );
    assert.equal(
      report.scheduledTasks.some((task) => 'permissionMode' in task),
      false,
    );
    assert.equal(report.summary.activeScheduledTaskCount, 1);
    assert.equal('executableScheduledTaskCount' in report.summary, false);
  });
});

function scheduledTask(status: ScheduledTaskStatus): ScheduledTask {
  return {
    id: status,
    title: status,
    intent: { kind: 'text', body: '' },
    schedule: { kind: 'once', runAt: 2_000 },
    effect: { kind: 'notify', channel: 'local' },
    status,
    nextFireAt: status === 'active' ? 2_000 : null,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt: 0,
    updatedAt: 0,
    runs: [],
    lastError: null,
  };
}
