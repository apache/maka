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
import { test } from 'node:test';
import { AttachmentIngestBlockedError, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { ATTACHMENT_APPROVAL_TTL_MS } from '../attachment-approval.js';
import { SessionLocalAttachmentRecovery } from '../session-local-attachment-recovery.js';
import { MAX_LOCAL_MESSAGE_BYTES } from '../session-local-store.js';

const owner = {
  senderId: 12,
  partition: 'authority-1',
  scope: { hostId: 'host-1', targetEpoch: 'target-1' },
  sessionId: 'session-1',
};
const attachment = () => ({
  name: 'private.txt', mimeType: 'text/plain', content: Uint8Array.from([0, 127, 128, 255]),
});
function blocked(code: AttachmentIngestBlockedError['code']): (error: unknown) => boolean {
  return (error) => error instanceof AttachmentIngestBlockedError && error.code === code;
}

test('recovery issues opaque approvals and display metadata, never local bytes or paths', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [approval] = recovery.issue(owner, [attachment()]);
  assert.match(approval.approvalId, /^local-recovery:[\da-f-]+$/);
  assert.deepEqual(Object.keys(approval).sort(), ['approvalId', 'mimeType', 'name', 'size']);
  assert.deepEqual(approval, {
    approvalId: approval.approvalId, name: 'private.txt', mimeType: 'text/plain', size: 4,
  });
  const [another] = recovery.issue(owner, [attachment()]);
  assert.notEqual(another.approvalId, approval.approvalId);
});

test('recovery preparation uses an immutable Main snapshot and ignores renderer metadata', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const original = attachment();
  const [approval] = recovery.issue(owner, [original]);
  original.content.fill(42);
  original.name = 'changed-after-issue.txt';
  original.mimeType = 'application/octet-stream';
  const prepared = recovery.prepare(owner, [{
    ...approval, name: 'spoofed.exe', mimeType: 'application/x-executable', size: 999,
    path: '/private/unapproved.txt', base64: 'c3Bvb2ZlZA==', content: Uint8Array.from([1]),
  }]);
  assert.deepEqual(prepared.items, [{ name: 'private.txt', mimeType: 'text/plain', base64: 'AH+A/w==' }]);
  assert.equal(prepared.commit(() => 'admitted'), 'admitted');
  assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
});

for (const [field, differentOwner] of [
  ['sender', { ...owner, senderId: owner.senderId + 1 }],
  ['Session', { ...owner, sessionId: 'session-2' }],
  ['Host', { ...owner, scope: { ...owner.scope, hostId: 'host-2' } }],
  ['target epoch', { ...owner, scope: { ...owner.scope, targetEpoch: 'target-2' } }],
  ['authority partition', { ...owner, partition: 'authority-2' }],
] as const) {
  test(`recovery approvals reject another ${field} without consuming the owner's approval`, () => {
    const recovery = new SessionLocalAttachmentRecovery();
    const [approval] = recovery.issue(owner, [attachment()]);
    assert.throws(() => recovery.prepare(differentOwner, [approval]), blocked('source_expired'));
    assert.equal(recovery.prepare(owner, [approval]).commit(() => true), true);
  });
}

test('forged and duplicate recovery approvals reject the entire preparation without consuming valid approvals', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [first, second] = recovery.issue(owner, [attachment(), attachment()]);
  assert.throws(() => recovery.prepare(owner, [first, { approvalId: 'local-recovery:forged' }]), blocked('source_expired'));
  assert.throws(() => recovery.prepare(owner, [first, second, { ...first, name: 'different-name.txt' }]), blocked('duplicate_source'));
  assert.equal(recovery.prepare(owner, [first, second]).items.length, 2);
  recovery.prepare(owner, [first, second]).commit(() => undefined);
  assert.throws(() => recovery.prepare(owner, [first]), blocked('source_expired'));
  assert.throws(() => recovery.prepare(owner, [second]), blocked('source_expired'));
});

test('unrelated attachment sources pass through for their own approval and ingest validation', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const normalApproval = { approvalId: 'native-picker-approval', name: 'picked.txt' };
  const clipboard = { name: 'paste.png', mimeType: 'image/png', base64: 'AAAA' };
  const prepared = recovery.prepare(owner, [normalApproval, clipboard, null]);
  assert.equal(prepared.items[0], normalApproval);
  assert.equal(prepared.items[1], clipboard);
  assert.equal(prepared.items[2], null);
});

test('recovery TTL is revalidated at commit after asynchronous preparation', () => {
  let now = 1000;
  const recovery = new SessionLocalAttachmentRecovery(() => now);
  const [approval] = recovery.issue(owner, [attachment()]);
  now += ATTACHMENT_APPROVAL_TTL_MS;
  const prepared = recovery.prepare(owner, [approval]);
  now += 1;
  let admitted = false;
  assert.throws(() => prepared.commit(() => { admitted = true; }), blocked('source_expired'));
  assert.equal(admitted, false, 'expired approvals cannot reach durable admission');
  assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
});

test('two prepared submissions cannot consume the same recovery approval twice', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [approval] = recovery.issue(owner, [attachment()]);
  const first = recovery.prepare(owner, [approval]);
  const concurrent = recovery.prepare(owner, [approval]);
  recovery.release(owner.senderId, [approval.approvalId]);
  assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
  let admissions = 0;
  first.commit(() => { admissions += 1; });
  assert.throws(() => concurrent.commit(() => { admissions += 1; }), blocked('source_expired'));
  assert.throws(() => first.commit(() => { admissions += 1; }), blocked('source_expired'));
  assert.equal(admissions, 1);
  first.dispose();
  concurrent.dispose();
});

test('a synchronous admission failure preserves every recovery approval for a retry', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const approvals = recovery.issue(owner, [attachment(), attachment()]);
  const prepared = recovery.prepare(owner, approvals);
  const failure = new Error('durable admission failed');
  assert.throws(() => prepared.commit(() => { throw failure; }), (error) => error === failure);
  assert.equal(recovery.prepare(owner, approvals).items.length, 2);
  assert.equal(prepared.commit(() => 'retry admitted'), 'retry admitted');
  for (const approval of approvals) assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
});

test('revoking one authority invalidates already prepared recovery without affecting another authority', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const otherOwner = { ...owner, partition: 'authority-2' };
  const [first] = recovery.issue(owner, [attachment()]);
  const [second] = recovery.issue(otherOwner, [attachment()]);
  const pending = recovery.prepare(owner, [first]);
  recovery.clear(owner.partition);
  assert.throws(() => pending.commit(() => assert.fail('revoked authority must not admit')), blocked('source_expired'));
  assert.throws(() => recovery.prepare(owner, [first]), blocked('source_expired'));
  assert.equal(recovery.prepare(otherOwner, [second]).commit(() => 'other authority admitted'), 'other authority admitted');
  const [remaining] = recovery.issue(otherOwner, [attachment()]);
  const anotherPending = recovery.prepare(otherOwner, [remaining]);
  recovery.clear();
  assert.throws(() => anotherPending.commit(() => assert.fail('cleared recovery must not admit')), blocked('source_expired'));
});

test('per-read attachment count rejects oversized issuance without evicting existing approvals', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [existing] = recovery.issue(owner, [attachment()]);
  assert.throws(() => recovery.issue(owner, Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, attachment)), blocked('count_limit'));
  assert.equal(recovery.issue(owner, Array.from({ length: MAX_ATTACHMENT_COUNT }, attachment)).length, MAX_ATTACHMENT_COUNT);
  assert.equal(recovery.prepare(owner, [existing]).commit(() => true), true);
});

test('registry entry capacity rejects atomically and TTL pruning makes space without evicting live approvals', () => {
  let now = 1000;
  const recovery = new SessionLocalAttachmentRecovery(() => now);
  const approvals: ReturnType<SessionLocalAttachmentRecovery['issue']> = [];
  for (let count = 0; count < 999; count += 1) approvals.push(...recovery.issue(owner, [attachment()]));
  assert.throws(() => recovery.issue(owner, [attachment(), attachment()]), blocked('total_size_exceeded'));
  const [last] = recovery.issue(owner, [attachment()]);
  assert.throws(() => recovery.issue(owner, [attachment()]), blocked('total_size_exceeded'));
  assert.equal(recovery.prepare(owner, [approvals[0]]).items.length, 1, 'a failed issuance does not evict a live approval');
  now += ATTACHMENT_APPROVAL_TTL_MS + 1;
  const [fresh] = recovery.issue(owner, [attachment()]);
  assert.equal(recovery.prepare(owner, [fresh]).commit(() => true), true);
  assert.throws(() => recovery.prepare(owner, [last]), blocked('source_expired'));
});

test('aggregate snapshot byte capacity rejects atomically and consumed bytes become available again', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const oneByte = { name: 'one.txt', mimeType: 'text/plain', content: Uint8Array.of(1) };
  const [existing] = recovery.issue(owner, [oneByte]);
  const chunk = new Uint8Array(MAX_LOCAL_MESSAGE_BYTES / 4);
  const largeFiles = Array.from({ length: 8 }, (_, index) => ({
    name: `part-${index}.bin`, mimeType: 'application/octet-stream',
    content: index === 7 ? chunk.subarray(1) : chunk,
  }));
  try {
    recovery.issue(owner, largeFiles);
    assert.throws(() => recovery.issue(owner, [oneByte]), blocked('total_size_exceeded'));
    assert.equal(recovery.prepare(owner, [existing]).commit(() => true), true, 'capacity rejection preserves existing approvals');
    const [replacement] = recovery.issue(owner, [oneByte]);
    assert.throws(() => recovery.issue(owner, [oneByte]), blocked('total_size_exceeded'));
    assert.equal(recovery.prepare(owner, [replacement]).commit(() => true), true);
  } finally {
    recovery.clear();
  }
});

test('repeated restore and discard releases snapshot capacity immediately', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  for (let count = 0; count < 1100; count += 1) {
    const [approval] = recovery.issue(owner, [attachment()]);
    recovery.release(owner.senderId, [approval.approvalId]);
    assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
  }
  const large = { ...attachment(), content: new Uint8Array(MAX_LOCAL_MESSAGE_BYTES / 4) };
  for (let count = 0; count < 3; count += 1) {
    const approvals = recovery.issue(owner, Array.from({ length: 8 }, () => large));
    assert.throws(() => recovery.issue(owner, [attachment()]), blocked('total_size_exceeded'));
    recovery.release(owner.senderId, approvals.map((approval) => approval.approvalId));
  }
  assert.equal(recovery.issue(owner, [attachment()]).length, 1);
  recovery.clear();
});

test('release is exact and sender-scoped, including abandoned Sessions and targets', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [first, retained] = recovery.issue(owner, [attachment(), attachment()]);
  const otherOwner = { ...owner, senderId: owner.senderId + 1 };
  const [other] = recovery.issue(otherOwner, [attachment()]);
  recovery.release(otherOwner.senderId, [first.approvalId, 'native-picker-approval']);
  const pending = recovery.prepare(owner, [first]);
  pending.dispose();
  recovery.release(owner.senderId, [first.approvalId, other.approvalId, 'local-recovery:unknown']);
  recovery.release(owner.senderId, [first.approvalId]);
  assert.throws(() => recovery.prepare(owner, [first]), blocked('source_expired'));
  assert.equal(recovery.prepare(owner, [retained]).commit(() => true), true);
  assert.equal(recovery.prepare(otherOwner, [other]).commit(() => true), true);
  const oldOwner = { ...owner, partition: 'old-authority', sessionId: 'old-session', scope: { hostId: 'old-host', targetEpoch: 'old-target' } };
  const [old] = recovery.issue(oldOwner, [attachment()]);
  recovery.release(owner.senderId, [old.approvalId]);
  assert.throws(() => recovery.prepare(oldOwner, [old]), blocked('source_expired'));
});

test('release validates the whole batch before changing any approval', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [approval] = recovery.issue(owner, [attachment()]);
  for (const ids of [null, approval.approvalId, [approval.approvalId, null], [approval.approvalId, ''],
    [approval.approvalId, 'x'.repeat(257)], new Array(2), Array.from({ length: 1001 }, () => approval.approvalId)]) {
    assert.throws(() => recovery.release(owner.senderId, ids), blocked('items_invalid'));
  }
  assert.equal(recovery.prepare(owner, [approval]).commit(() => true), true);
});

test('release defers to an already prepared send but prevents new sends', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [approval] = recovery.issue(owner, [attachment()]);
  const pending = recovery.prepare(owner, [approval]);
  recovery.release(owner.senderId, [approval.approvalId]);
  assert.throws(() => recovery.prepare(owner, [approval]), blocked('source_expired'));
  assert.equal(pending.commit(() => 'durable'), 'durable');
  pending.dispose();
  pending.dispose();
  assert.throws(() => pending.commit(() => assert.fail('disposed send cannot admit')), blocked('source_expired'));
});

test('the last in-flight lease releases abandoned bytes even when admission fails', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const approvals = Array.from({ length: 1000 }, () => recovery.issue(owner, [attachment()])[0]);
  const pending = recovery.prepare(owner, [approvals[0]]);
  const concurrent = recovery.prepare(owner, [approvals[0]]);
  recovery.release(owner.senderId, [approvals[0].approvalId]);
  pending.dispose();
  pending.dispose();
  assert.throws(() => recovery.issue(owner, [attachment()]), blocked('total_size_exceeded'));
  assert.throws(() => concurrent.commit(() => { throw new Error('admission failed'); }), /admission failed/);
  concurrent.dispose();
  assert.equal(recovery.issue(owner, [attachment()]).length, 1);
  assert.throws(() => recovery.prepare(owner, [approvals[0]]), blocked('source_expired'));
});

test('disposing a failed send without a release preserves the source for retry', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const [approval] = recovery.issue(owner, [attachment()]);
  const pending = recovery.prepare(owner, [approval]);
  assert.throws(() => pending.commit(() => { throw new Error('admission failed'); }), /admission failed/);
  pending.dispose();
  assert.throws(() => pending.commit(() => true), blocked('source_expired'));
  const retry = recovery.prepare(owner, [approval]);
  assert.equal(retry.commit(() => true), true);
  retry.dispose();
});

test('partial preparation failure does not pin any valid snapshot', () => {
  const recovery = new SessionLocalAttachmentRecovery();
  const approvals = Array.from({ length: 1000 }, () => recovery.issue(owner, [attachment()])[0]);
  assert.throws(() => recovery.prepare(owner, [approvals[0], { approvalId: 'local-recovery:unknown' }]), blocked('source_expired'));
  recovery.release(owner.senderId, [approvals[0].approvalId]);
  assert.equal(recovery.issue(owner, [attachment()]).length, 1);
});

test('released in-flight leases still honor expiration, authority purge, and service shutdown', () => {
  for (const invalidate of ['ttl', 'partition', 'all'] as const) {
    let now = 1000;
    const recovery = new SessionLocalAttachmentRecovery(() => now);
    const [approval] = recovery.issue(owner, [attachment()]);
    const pending = recovery.prepare(owner, [approval]);
    recovery.release(owner.senderId, [approval.approvalId]);
    if (invalidate === 'ttl') now += ATTACHMENT_APPROVAL_TTL_MS + 1;
    else recovery.clear(invalidate === 'partition' ? owner.partition : undefined);
    assert.throws(() => pending.commit(() => assert.fail('revoked send cannot admit')), blocked('source_expired'));
    pending.dispose();
  }
});
