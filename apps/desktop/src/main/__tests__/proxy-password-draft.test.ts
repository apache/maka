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

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProxyPasswordDraft,
  runAfterProxyPasswordCommit,
} from "../../renderer/features/network-proxy/testing.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("proxy password typing remains local until the complete draft is committed", async () => {
  const saved: string[] = [];
  const draft = createProxyPasswordDraft(async (secret) => {
    saved.push(secret);
  });

  for (const value of ["s", "se", "sec", "secret"]) draft.edit(value);
  assert.deepEqual(saved, []);
  assert.equal(draft.value, "secret");

  await draft.commit();
  assert.deepEqual(saved, ["secret"]);
  assert.equal(draft.value, "");
});

test("Enter followed by focus exit reuses one in-flight save", async () => {
  const write = deferred();
  let calls = 0;
  const draft = createProxyPasswordDraft(async () => {
    calls += 1;
    await write.promise;
  });
  draft.edit("complete-secret");

  const entered = draft.commit();
  const blurred = draft.commit();

  assert.equal(entered, blurred);
  assert.equal(calls, 1);
  write.resolve();
  await entered;
  assert.equal(draft.pending, false);
});

test("a failed save retains the complete draft for retry", async () => {
  const draft = createProxyPasswordDraft(async () => {
    throw new Error("save failed");
  });
  draft.edit("complete-secret");

  await assert.rejects(draft.commit(), /save failed/);

  assert.equal(draft.value, "complete-secret");
  assert.equal(draft.pending, false);
});

test("an old save response never clears edits made while it was pending", async () => {
  const first = deferred();
  const saved: string[] = [];
  const draft = createProxyPasswordDraft(async (secret) => {
    saved.push(secret);
    if (saved.length === 1) await first.promise;
  });
  draft.edit("first-secret");
  const savingFirst = draft.commit();
  draft.edit("second-secret");

  first.resolve();
  await savingFirst;
  assert.equal(draft.value, "second-secret");

  await draft.commit();
  assert.deepEqual(saved, ["first-secret", "second-secret"]);
  assert.equal(draft.value, "");
});

test("a test-time commit waits for an in-flight save then commits newer edits", async () => {
  const first = deferred();
  const saved: string[] = [];
  const draft = createProxyPasswordDraft(async (secret) => {
    saved.push(secret);
    if (saved.length === 1) await first.promise;
  });
  draft.edit("first-secret");
  void draft.commit();
  draft.edit("latest-secret");

  const beforeTest = draft.commit();
  first.resolve();
  await beforeTest;

  assert.deepEqual(saved, ["first-secret", "latest-secret"]);
  assert.equal(draft.value, "");
});

test("cancel clears only work that has not entered the save lane", async () => {
  const write = deferred();
  const draft = createProxyPasswordDraft(async () => write.promise);
  draft.edit("queued-secret");
  const saving = draft.commit();
  draft.edit("unsubmitted-change");

  draft.cancel();
  assert.equal(draft.value, "queued-secret");

  write.resolve();
  await saving;
  assert.equal(draft.value, "");

  draft.edit("local-only");
  draft.cancel();
  assert.equal(draft.value, "");
});

test("empty drafts are keep operations", async () => {
  let calls = 0;
  const draft = createProxyPasswordDraft(async () => {
    calls += 1;
  });

  await draft.commit();

  assert.equal(calls, 0);
});

test("proxy testing waits for the save and aborts when that save fails", async () => {
  const write = deferred();
  let tests = 0;
  const draft = createProxyPasswordDraft(async () => write.promise);
  draft.edit("complete-secret");

  const testing = runAfterProxyPasswordCommit(draft, async () => {
    tests += 1;
    return "tested";
  });
  assert.equal(tests, 0);
  write.reject(new Error("save failed"));
  await assert.rejects(testing, /save failed/);
  assert.equal(tests, 0);
});
