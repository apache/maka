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

import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Independent file, review, calendar and task APIs. Writes enforce their own API
// contracts, not the delegation's business rules; the evaluator checks those later.
export async function createHandoffFixture({ root, startedAt, now = Date.now }) {
  const date = new Date(startedAt + 86400000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Shanghai',
  });
  const calls = [],
    events = [],
    taskWrites = [];
  let slotRace = false,
    lostConfirmation = false,
    taskConflict = false,
    laterChange = false;
  const takenSlots = new Set();
  const task = {
    id: 'BRAND-42',
    projectId: 'brand-refresh',
    version: 1,
    status: 'in_progress',
    title: '品牌升级设计验收',
    fileId: null,
    calendarEventId: null,
    note: '等设计交付和验收安排',
  };
  const elapsed = () => now() - startedAt;
  const stamp = () => ({
    observedAt: new Date(now()).toISOString(),
    nowMs: now(),
    timezone: 'Asia/Shanghai',
  });
  const files = () => [
    {
      id: 'design-v1',
      version: 1,
      name: '品牌升级交付稿 v1',
      uploadedAt: new Date(startedAt).toISOString(),
      checksumVerified: true,
      url: 'https://mock-drive.invalid/brand-refresh/design-v1',
      note: '第一版交付稿',
    },
    ...(elapsed() >= 100000
      ? [
          {
            id: 'design-v2',
            version: 2,
            name: '品牌升级交付稿 v2',
            uploadedAt: new Date(startedAt + 100000).toISOString(),
            checksumVerified: true,
            url: 'https://mock-drive.invalid/brand-refresh/design-v2',
            note: '调整字号和按钮对比度',
          },
        ]
      : []),
    ...(elapsed() >= 180000
      ? [
          {
            id: 'design-v3',
            version: 3,
            name: '品牌升级交付稿 v3',
            uploadedAt: new Date(startedAt + 180000).toISOString(),
            checksumVerified: true,
            url: 'https://mock-drive.invalid/brand-refresh/design-v3',
            note: '修复 v2 的对比度问题',
          },
        ]
      : []),
    ...(laterChange
      ? [
          {
            id: 'design-v4',
            version: 4,
            name: '品牌升级额外备选稿',
            uploadedAt: new Date(now()).toISOString(),
            checksumVerified: true,
            url: 'https://mock-drive.invalid/brand-refresh/design-v4',
            note: '另一个独立提案',
          },
        ]
      : []),
  ];
  const reviews = () => [
    {
      id: 'visual-v1',
      fileId: 'design-v1',
      category: 'visual',
      status: elapsed() >= 80000 ? 'approved' : 'pending',
      reviewer: '设计负责人',
      note: 'v1 视觉验收',
    },
    ...(elapsed() >= 120000
      ? [
          {
            id: 'access-v1',
            fileId: 'design-v1',
            category: 'accessibility',
            status: 'approved',
            reviewer: '无障碍审核员',
            note: '仅针对 v1，此记录不涉及其他版本',
          },
        ]
      : []),
    ...(elapsed() >= 100000
      ? [
          {
            id: 'visual-v2',
            fileId: 'design-v2',
            category: 'visual',
            status: 'approved',
            reviewer: '设计负责人',
            note: 'v2 视觉验收',
          },
          {
            id: 'access-v2',
            fileId: 'design-v2',
            category: 'accessibility',
            status: elapsed() >= 140000 ? 'rejected' : 'pending',
            reviewer: '无障碍审核员',
            note: elapsed() >= 140000 ? '主要按钮对比度不达标，需修订后重新审核' : '审核中',
          },
        ]
      : []),
    ...(elapsed() >= 180000
      ? [
          {
            id: 'visual-v3',
            fileId: 'design-v3',
            category: 'visual',
            status: 'approved',
            reviewer: '设计负责人',
            note: 'v3 视觉验收',
          },
          {
            id: 'access-v3',
            fileId: 'design-v3',
            category: 'accessibility',
            status: elapsed() >= 220000 ? 'approved' : 'pending',
            reviewer: '无障碍审核员',
            note: elapsed() >= 220000 ? 'v3 对比度和字号检查通过' : '审核中',
          },
        ]
      : []),
  ];
  const availableSlots = () =>
    [
      { date, startTime: '15:00', endTime: '15:30' },
      { date, startTime: '16:00', endTime: '16:30' },
      { date, startTime: '16:30', endTime: '17:00' },
    ].filter(
      (slot) =>
        !(elapsed() >= 110000 && slot.startTime === '15:00') &&
        !takenSlots.has(slot.startTime) &&
        !events.some((event) => event.startTime === slot.startTime),
    );
  const snapshot = () => ({
    ...stamp(),
    date,
    files: files(),
    reviews: reviews(),
    availableSlots: availableSlots(),
    events,
    task,
    taskWrites,
    calls,
    slotRace,
    lostConfirmation,
    taskConflict,
  });
  let persistence = Promise.resolve();
  const persist = () => {
    const json = JSON.stringify(snapshot(), null, 2);
    persistence = persistence.then(() => writeFile(join(root, 'handoff-services.json'), json));
    return persistence;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let call;
    try {
      let input = Object.fromEntries(url.searchParams);
      if (req.method === 'POST' || req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 32000) throw new Error('Request too large');
        }
        input = JSON.parse(body);
      }
      call = {
        at: now(),
        elapsedMs: elapsed(),
        method: req.method,
        path: url.pathname,
        input,
      };
      calls.push(call);
      const respond = async (status, body) => {
        call.status = status;
        call.result = structuredClone(body);
        await persist();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/files')
        return respond(200, {
          ...stamp(),
          projectId: 'brand-refresh',
          files: files(),
          latestFileId: files().at(-1).id,
        });
      if (req.method === 'GET' && url.pathname === '/reviews')
        return respond(200, {
          ...stamp(),
          reviews: reviews().filter((review) => !input.fileId || review.fileId === input.fileId),
        });
      if (req.method === 'GET' && url.pathname === '/calendar/freebusy')
        return respond(200, {
          ...stamp(),
          date,
          participants: [
            { id: 'me', name: '我' },
            { id: 'design-lead', name: '设计负责人' },
          ],
          commonFreeSlots: availableSlots(),
        });
      if (req.method === 'GET' && url.pathname === '/calendar/events')
        return respond(200, {
          ...stamp(),
          events: events.filter(
            (event) => !input.clientRequestId || event.clientRequestId === input.clientRequestId,
          ),
        });
      if (req.method === 'GET' && url.pathname === '/task')
        return respond(200, { ...stamp(), task: { ...task } });
      if (req.method === 'POST' && url.pathname === '/calendar/events') {
        const prior = events.find((event) => event.clientRequestId === input.clientRequestId);
        const signature = JSON.stringify(input);
        if (prior)
          return respond(
            prior.signature === signature ? 200 : 409,
            prior.signature === signature
              ? { ...stamp(), event: prior, duplicateRequest: true }
              : { error: 'Idempotency key reused with different arguments' },
          );
        const slot = availableSlots().find(
          (candidate) =>
            candidate.date === input.date &&
            candidate.startTime === input.startTime &&
            candidate.endTime === input.endTime,
        );
        if (
          !slot ||
          !files().some((file) => file.id === input.fileId) ||
          !input.clientRequestId ||
          input.participantIds?.slice().sort().join(',') !== 'design-lead,me'
        )
          return respond(409, {
            ...stamp(),
            error: 'Invalid meeting data or requested slot is no longer free',
          });
        if (!slotRace) {
          slotRace = true;
          takenSlots.add(input.startTime);
          return respond(409, {
            ...stamp(),
            error:
              'Another calendar change took this time slot before creation. Event was not created.',
          });
        }
        const event = {
          id: `meeting-${events.length + 1}`,
          status: 'confirmed',
          ...input,
          signature,
          createdAt: now(),
        };
        events.push(event);
        call.committedEventId = event.id;
        if (!lostConfirmation) {
          lostConfirmation = true;
          call.status = 'response-lost-after-commit';
          await persist();
          res.destroy();
          return;
        }
        return respond(201, { ...stamp(), event });
      }
      if (req.method === 'PATCH' && url.pathname === '/task') {
        const prior = taskWrites.find(
          (write) => write.input.clientRequestId === input.clientRequestId,
        );
        if (prior)
          return respond(
            JSON.stringify(prior.input) === JSON.stringify(input) ? 200 : 409,
            JSON.stringify(prior.input) === JSON.stringify(input)
              ? { ...stamp(), task: prior.task, duplicateRequest: true }
              : { error: 'Idempotency key reused with different arguments' },
          );
        if (!taskConflict) {
          taskConflict = true;
          task.version++;
          task.note = '项目经理补充：保留历史稿件，会议使用确认过的版本。';
        }
        if (input.expectedVersion !== task.version)
          return respond(409, {
            ...stamp(),
            error: 'Task revision conflict; read the latest task before retrying',
            currentVersion: task.version,
          });
        if (
          input.taskId !== task.id ||
          !input.clientRequestId ||
          !files().some((file) => file.id === input.fileId) ||
          !events.some((event) => event.id === input.calendarEventId)
        )
          return respond(400, {
            error: 'Invalid task update or unknown linked resource',
          });
        Object.assign(task, {
          version: task.version + 1,
          status: input.status,
          fileId: input.fileId,
          calendarEventId: input.calendarEventId,
        });
        taskWrites.push({
          at: now(),
          input: structuredClone(input),
          task: { ...task },
        });
        return respond(200, { ...stamp(), task: { ...task } });
      }
      return respond(404, { error: 'Unknown endpoint' });
    } catch (error) {
      if (call) call.failure = String(error);
      if (!res.destroyed) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await persist();
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    date,
    events,
    task,
    taskWrites,
    calls,
    snapshot,
    persist,
    async publishLaterChange() {
      laterChange = true;
      await persist();
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await persist();
    },
  };
}
