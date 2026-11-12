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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeController } from '../../../../src/assistant/index-initiative/controller.js';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { output, view, note } from './notebook-output.js';

// Real scheduler/store/notebook, controlled model and Bot transport. Invalid user
// feedback must roll back the draft and be returned to its author, not swallowed.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'initiative-submission-'));
  const posted: any[] = [],
    prompts: string[] = [];
  let runner: (prompt: string) => Promise<void> = async () => {};
  let post = (message: any) => {
    posted.push(message);
    return true;
  };
  const agent = {
    followup: async (prompt: string) => {
      prompts.push(prompt);
      return { disposition: 'turn_started' };
    },
    whenIdle: async () => runner(prompts.at(-1)!),
    snapshot: async () => ({ agent: { status: 'idle' } }),
  };
  const ctx = {
    bot: {
      discoveryContext: () => ({ deliveries: [], feedback: [] }),
      post: (_owner: string, message: any) => post(message),
    },
  };
  let store: InitiativeStore;
  let controller: InitiativeController;
  const open = () => {
    store = new InitiativeStore(directory, 'test-owner');
    store.lease();
    store.recover();
    controller = new InitiativeController(ctx, store, {});
  };
  open();
  store!.bind({ sessionId: 'owner', cwd: directory });
  store!.update((s) => {
    s.pendingJudgement = true;
    s.judgementSession = 'judge';
  });
  return {
    posted,
    prompts,
    get store() {
      return store;
    },
    get book() {
      return controller.notebook;
    },
    setRunner(fn: typeof runner) {
      runner = fn;
    },
    setPost(fn: typeof post) {
      post = fn;
    },
    async run() {
      store.control('check');
      await controller.run(agent, store.claim());
    },
    restart() {
      controller.notebook.close();
      store.release();
      store.close();
      open();
    },
    close() {
      controller.notebook.close();
      store.release();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const message = { text: '报名窗口今天关闭，确认后及时报名。', topicIds: [note.topicId] };
const validDraft = { notes: [note], messages: [message] };
const invalidDraft = {
  ...validDraft,
  feedbackDecisions: [
    { feedbackId: 'historical-feishu-message', understanding: '停止用车跟进', rules: [] },
  ],
};
const resultPath = (prompt: string) => /完成后把增量操作写入 (.+)，格式：/.exec(prompt)![1];

test('failed feedback submission is repaired in the same wake and reminder is handed off once', async () => {
  const f = fixture();
  try {
    f.setRunner(async (prompt) => {
      if (f.prompts.length === 1) return output(prompt, invalidDraft);
      assert.equal(f.prompts.length, 2);
      assert.match(prompt, /Real user feedback and interpretation required/);
      assert.match(prompt, /整份操作未写入记事本/);
      assert.match(prompt, /不在待发送队列/);
      assert.equal(resultPath(prompt), resultPath(f.prompts[0]));
      assert.deepEqual(JSON.parse(readFileSync(resultPath(prompt), 'utf8')), {
        notes: [],
        messages: [],
        feedbackDecisions: [],
        ...invalidDraft,
      });
      assert.equal(f.book.events().length, 0, 'no partial notes, feedback or prepared messages');
      assert.equal(f.posted.length, 0);
      await output(prompt, validDraft);
    });
    await f.run();
    assert.equal(f.prompts.length, 2);
    assert.equal(f.store.get().lastError, null);
    assert.equal(f.store.get().pendingDraft, undefined);
    assert.equal(f.book.events('note').length, 1);
    assert.equal(f.book.events('prepared').length, 1);
    assert.equal(f.book.events('reported').length, 1);
    assert.equal(f.book.events('delivery').length, 0, 'handoff is not a delivery receipt');
    assert.deepEqual(
      f.posted.map((x) => x.content),
      [message.text],
    );
  } finally {
    f.close();
  }
});

test('provider failure during repair retains the draft and rejection across restart and reconfiguration', async () => {
  const f = fixture();
  try {
    f.setRunner(async (prompt) => {
      if (f.prompts.length === 1) return output(prompt, invalidDraft);
      throw Error('provider unavailable');
    });
    await f.run();
    assert.match(f.store.get().lastError, /provider unavailable/);
    const pending = f.store.get().pendingDraft;
    assert.match(pending.error, /Real user feedback/);
    f.restart();
    f.store.configure({ sessionId: 'owner', cwd: f.store.directory }, 5400000, false);
    assert.deepEqual(f.store.get().pendingDraft, pending);
    f.setRunner(async (prompt) => {
      assert.match(prompt, /上次结果未提交/);
      assert.match(prompt, /Real user feedback/);
      assert.equal(resultPath(prompt), resultPath(f.prompts[0]));
      assert.equal(f.book.events().length, 0);
      await output(prompt, validDraft);
    });
    await f.run();
    assert.equal(f.store.get().lastError, null);
    assert.equal(f.posted.length, 1);
    assert.equal(f.posted[0].content, message.text);
  } finally {
    f.close();
  }
});

test('committed draft retries Bot handoff after restart without another model call or duplicate notes', async () => {
  const f = fixture();
  const ids: string[] = [];
  try {
    f.setRunner((prompt) => output(prompt, validDraft));
    f.setPost((message) => {
      ids.push(message.id);
      return false;
    });
    await f.run();
    assert.match(f.store.get().lastError, /Bot did not accept/);
    assert.equal(f.book.events('draft').length, 1);
    f.restart();
    f.setRunner(async () => {
      assert.fail('already committed: must not ask model to regenerate');
    });
    f.setPost((message) => {
      ids.push(message.id);
      f.posted.push(message);
      return true;
    });
    await f.run();
    assert.equal(f.prompts.length, 1);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(f.book.events('note').length, 1);
    assert.equal(f.book.events('reported').length, 1);
    assert.equal(f.posted.length, 1);
    assert.equal(f.store.get().lastError, null);
  } finally {
    f.close();
  }
});

test('malformed JSON is returned for repair, with no three-rejection pause limit', async () => {
  const f = fixture();
  try {
    f.setRunner(async (prompt) => {
      if (f.prompts.length <= 4) writeFileSync(resultPath(prompt), '{broken');
      else {
        assert.match(prompt, /SyntaxError/);
        await output(prompt, validDraft);
      }
    });
    await f.run();
    assert.equal(f.prompts.length, 5);
    assert.equal(f.store.get().lastError, null);
    assert.equal(f.posted.length, 1);
    assert.equal(new Set(f.prompts.map((p) => /Submission attempt: (.+)/.exec(p)![1])).size, 5);
  } finally {
    f.close();
  }
});

test('missing output remains recoverable without pretending it was committed', async () => {
  const f = fixture();
  try {
    await f.run();
    assert.match(f.store.get().lastError, /ENOENT/);
    assert.equal(f.book.events().length, 0);
    f.restart();
    f.setRunner(async (prompt) => {
      assert.match(prompt, /上次结果未提交/);
      assert.match(prompt, /ENOENT/);
      assert.match(readFileSync(view(prompt), 'utf8'), /暂无用户反馈/);
      await output(prompt, validDraft);
    });
    await f.run();
    assert.equal(f.posted.length, 1);
  } finally {
    f.close();
  }
});
