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
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpExecutor, type AcpAgentAdapter, type AcpContinuityRecord } from '../index.js';
import { readWorkspaceTextFile } from '../acp-filesystem.js';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginExecutorService } from '@maka/runtime/plugin-executor-service';
import { PluginExecutorBackend } from '@maka/runtime/plugin-executor-backend';
import type {
  PluginExecutorContext,
  PluginExecutorOutputEvent,
} from '@maka/runtime/plugin-executor-service';

// This fixture exercises the actual SDK, stdio transport, OS processes and callbacks.
const program = String.raw`
const {createInterface}=require('node:readline');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const pending=new Map(); let seq=0, turn=0, cwd, promptId, history=[];
const historyPath=()=>cwd+'/.acp-fixture-history.json';
const persist=()=>fs.writeFileSync(historyPath(),JSON.stringify(history));
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const respond=(id,result)=>send({id,result});
const update=(update)=>{history.push(update);persist();send({method:'session/update',params:{sessionId:'fixture',update}});};
const text=(text)=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const call=(method,params)=>new Promise(resolve=>{const id='client-'+(++seq);pending.set(id,resolve);send({id,method,params});});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
 if(m.method==='initialize')return respond(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}});
 if(m.method==='session/new'){
  cwd=m.params.cwd;
  if(fs.existsSync(historyPath()))return send({id:m.id,error:{code:-32000,message:'Session already exists'}});
  history=[];persist();return respond(m.id,{sessionId:'fixture',configOptions:[]});
 }
 if(m.method==='session/resume'||m.method==='session/load'){
  cwd=m.params.cwd;
  if(m.params.sessionId!=='fixture'||!fs.existsSync(historyPath()))
   return send({id:m.id,error:{code:-32000,message:'Unknown Session'}});
  history=JSON.parse(fs.readFileSync(historyPath(),'utf8'));
  turn=history.filter(item=>item.sessionUpdate==='user_message_chunk').length;
  if(m.method==='session/load')for(const item of history)
   send({method:'session/update',params:{sessionId:'fixture',update:item}});
  return respond(m.id,{configOptions:[]});
 }
 if(m.method==='session/cancel'){if(promptId!==undefined){respond(promptId,{stopReason:'cancelled'});promptId=undefined;}return;}
 if(m.method!=='session/prompt')return;
 const value=m.params.prompt[0].text;
 update({sessionUpdate:'user_message_chunk',content:{type:'text',text:value}});
 if(value==='crash'){process.exit(3);return;}
 if(value==='refusal'){respond(m.id,{stopReason:'refusal'});return;}
 if(value==='ignore-cancel'){text('waiting');return;}
 if(value==='wait'){promptId=m.id;text('waiting');return;}
 if(value==='helper'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});text(String(child.pid));respond(m.id,{stopReason:'end_turn'});return;}
 if(value.startsWith('write:')){
  const result=await call('fs/write_text_file',{sessionId:'fixture',...JSON.parse(value.slice(6))});
  text(JSON.stringify(result));
 }else if(value.startsWith('metadata:')){
  const metadata=JSON.parse(value.slice(9));
  update({sessionUpdate:'tool_call',toolCallId:'metadata-tool',title:metadata.title,name:metadata.name,kind:'edit',status:'in_progress'});
  update({sessionUpdate:'tool_call_update',toolCallId:'metadata-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'edit completed'}}]});
 }else if(value.startsWith('diff:')){
  const newline=JSON.parse(value.slice(5));
  const content='new'+newline;
  await call('fs/write_text_file',{sessionId:'fixture',path:cwd+'/edited.txt',content});
  update({sessionUpdate:'tool_call',toolCallId:'edit',title:'Edit file',kind:'edit',status:'in_progress'});
  update({sessionUpdate:'tool_call_update',toolCallId:'edit',status:'completed',content:[{type:'diff',path:'edited.txt',oldText:'old'+newline,newText:content}]});
 }else if(value==='files'){
  const write=await call('fs/write_text_file',{sessionId:'fixture',path:cwd+'/created.txt',content:'fixture'});
  const read=await call('fs/read_text_file',{sessionId:'fixture',path:cwd+'/created.txt'});
  const escape=await call('fs/read_text_file',{sessionId:'fixture',path:cwd+'/escape.txt'});
  text(JSON.stringify({write:!!write.result,read:read.result?.content,escape:!!escape.error}));
 }else{
  const result=await call('session/request_permission',{sessionId:'fixture',toolCall:{toolCallId:'interaction_fixture',title:'Alpha or beta?'},options:[{optionId:'alpha-id',name:'Alpha',kind:'allow_once'},{optionId:'beta-id',name:'Beta',kind:'allow_once'}]});
  text(JSON.stringify({pid:process.pid,turn:++turn,choice:result.result.outcome.optionId}));
 }
 respond(m.id,{stopReason:'end_turn'});
});
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-process-'));
  const script = join(root, 'agent.cjs');
  await writeFile(script, program);
  const adapter: AcpAgentAdapter = {
    id: 'stdio-fixture',
    displayName: 'Fixture',
    configure: () => ({ launch: { executable: process.execPath, args: [script] } }),
    permissionKind: () => 'question',
  };
  const marked = new Set<string>();
  const executor = new AcpExecutor(
    adapter,
    {},
    {
      state: {
        has: async (key) => marked.has(key),
        mark: async (key) => {
          marked.add(key);
        },
      },
    },
  );
  const request = (text: string) => ({
    sessionId: 'task',
    conversationKey: 'task',
    turnId: text,
    text,
    cwd: root,
  });
  const context = (
    signal = new AbortController().signal,
    emit: (event: PluginExecutorOutputEvent) => void = () => {},
  ): PluginExecutorContext => ({
    signal,
    emit,
    requestPermission: async (request) => {
      assert.equal(request.kind, 'question');
      return { outcome: 'selected', optionId: 'beta-id' };
    },
  });
  return {
    root,
    script,
    executor,
    request,
    context,
    dispose: async () => {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('file read rejects invalid ranges and honors a zero limit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-acp-read-range-'));
  try {
    const path = join(cwd, 'lines.txt');
    await writeFile(path, 'first\nsecond\nthird');
    await assert.rejects(() => readWorkspaceTextFile(cwd, path, -3), /positive integer/u);
    await assert.rejects(() => readWorkspaceTextFile(cwd, path, 0), /positive integer/u);
    await assert.rejects(() => readWorkspaceTextFile(cwd, path, 1, -1), /non-negative integer/u);
    assert.equal(await readWorkspaceTextFile(cwd, path, 2, 1), 'second');
    assert.equal(await readWorkspaceTextFile(cwd, path, undefined, 0), '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('real stdio retains a conversation and returns original question option ids', async () => {
  const f = await fixture();
  try {
    const first = await f.executor.execute(f.request('one'), f.context());
    const second = await f.executor.execute(f.request('two'), f.context());
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    if (first.status !== 'completed' || second.status !== 'completed')
      throw new Error('Expected completion');
    const a = JSON.parse(first.text),
      b = JSON.parse(second.text);
    assert.equal(a.pid, b.pid);
    assert.equal(b.turn, 2);
    assert.equal(b.choice, 'beta-id');
  } finally {
    await f.dispose();
  }
});

test('real stdio restores the same Session in a new process after durable acknowledgement', async () => {
  const f = await fixture();
  const values = new Map<string, unknown>();
  const state = {
    has: async (key: string) => values.has(key),
    mark: async (key: string, cwd: string) => {
      values.set(key, { version: 1, cwd });
    },
    read: async (key: string) => values.get(key),
    write: async (key: string, record: unknown) => {
      values.set(key, record);
    },
  };
  const adapter: AcpAgentAdapter = {
    id: 'stdio-restore-fixture',
    displayName: 'Fixture',
    configure: () => ({ launch: { executable: process.execPath, args: [f.script] } }),
    permissionKind: () => 'question',
  };
  const make = () => new AcpExecutor(adapter, {}, { state });
  const first = make();
  try {
    const initial = await first.execute(f.request('one'), f.context());
    assert.equal(initial.status, 'completed');
    if (initial.status !== 'completed') throw new Error('Expected first completion');
    await first.acknowledgeExecution('task', 'one');
    const firstPid = JSON.parse(initial.text).pid as number;
    assert.notEqual(firstPid, process.pid);
    process.kill(firstPid, 'SIGKILL');
    let readiness: string | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      readiness = (await first.inspectConversation({ conversationKey: 'task', cwd: f.root }))
        .readiness;
      if (readiness === 'restorable') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readiness, 'restorable');
    await first.dispose();
    const restored = make();
    try {
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
        'restorable',
      );
      const later = await restored.execute(f.request('two'), f.context());
      assert.equal(later.status, 'completed');
      if (later.status !== 'completed') throw new Error('Expected restored completion');
      assert.notEqual(JSON.parse(initial.text).pid, JSON.parse(later.text).pid);
      assert.equal(JSON.parse(later.text).turn, 2);
      await restored.acknowledgeExecution('task', 'two');
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
        'ready',
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await f.dispose();
  }
});

for (const prompt of ['wait', 'refusal', 'ignore-cancel', 'crash']) {
  test(`real stdio checkpoint after ${prompt} preserves safe restart behavior`, async () => {
    const f = await fixture();
    const values = new Map<string, AcpContinuityRecord>();
    const state = {
      has: async (key: string) => values.has(key),
      mark: async () => {
        throw new Error('Expected versioned storage');
      },
      read: async (key: string) => values.get(key),
      write: async (key: string, record: AcpContinuityRecord) => {
        values.set(key, record);
      },
    };
    const adapter: AcpAgentAdapter = {
      id: 'stdio-checkpoint-fixture',
      displayName: 'Fixture',
      configure: () => ({ launch: { executable: process.execPath, args: [f.script] } }),
      permissionKind: () => 'question',
    };
    const make = () => new AcpExecutor(adapter, {}, { state });
    const first = make();
    const root = new Context();
    const service = new PluginExecutorService(root);
    root
      .extend({
        maka: { rootId: 'profile', packageId: 'fixture', entryId: 'stdio', generation: 1 },
      })
      .executors.register(first);
    const backend = new PluginExecutorBackend({
      sessionId: 'task',
      cwd: f.root,
      binding: service.bind('task', first.id),
    });
    const restored = make();
    try {
      let firstPid: number | undefined;
      for await (const event of backend.send({ turnId: 'one', text: 'one' })) {
        if (event.type === 'text_complete') firstPid = JSON.parse(event.text).pid;
      }
      assert.equal(values.get('task')?.phase, 'committed');
      const terminalEvents: string[] = [];
      for await (const event of backend.send({ turnId: 'stopped', text: prompt })) {
        terminalEvents.push(event.type);
        if (event.type === 'text_delta') await backend.stop('user_stop');
        if (event.type === 'complete')
          assert.equal(values.get('task')?.phase, 'prompt_pending', 'delivery alone cannot commit');
      }
      assert.equal(terminalEvents.at(-1), 'complete');
      assert.ok(terminalEvents.includes(['crash', 'refusal'].includes(prompt) ? 'error' : 'abort'));
      const settled = prompt === 'wait' || prompt === 'refusal';
      assert.equal(values.get('task')?.phase, settled ? 'committed' : 'prompt_pending');
      assert.equal(values.get('task')?.committedPrompts, settled ? 2 : 1);
      await first.dispose();
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
        settled ? 'restorable' : 'history_gap',
      );
      const events: PluginExecutorOutputEvent[] = [];
      const result = await restored.execute(
        f.request('after'),
        f.context(undefined, (event) => events.push(event)),
      );
      if (settled) {
        assert.equal(result.status, 'completed');
        if (result.status !== 'completed') throw new Error('Expected restored completion');
        assert.equal(JSON.parse(result.text).turn, 3);
        assert.notEqual(JSON.parse(result.text).pid, firstPid);
        await restored.acknowledgeExecution('task', 'after');
        assert.equal(values.get('task')?.committedPrompts, 3);
      } else {
        assert.equal(result.status, 'failed');
        if (result.status !== 'failed') throw new Error('Expected history gap');
        assert.equal(result.code, 'acp_history_gap');
        assert.deepEqual(events, [], 'uncertain replay must not reach canonical history');
      }
    } finally {
      await backend.dispose();
      await root.fiber.dispose();
      await first.dispose();
      await restored.dispose();
      await f.dispose();
    }
  });
}

test('real stdio load replay stays separate when the Agent may be ahead of durable history', async () => {
  const f = await fixture();
  const values = new Map<string, unknown>();
  const state = {
    has: async (key: string) => values.has(key),
    mark: async (key: string, cwd: string) => {
      values.set(key, { version: 1, cwd });
    },
    read: async (key: string) => values.get(key),
    write: async (key: string, record: unknown) => {
      values.set(key, record);
    },
  };
  const adapter: AcpAgentAdapter = {
    id: 'stdio-restore-fixture',
    displayName: 'Fixture',
    configure: () => ({ launch: { executable: process.execPath, args: [f.script] } }),
    permissionKind: () => 'question',
  };
  const make = () => new AcpExecutor(adapter, {}, { state });
  const first = make();
  try {
    assert.equal((await first.execute(f.request('one'), f.context())).status, 'completed');
    // Simulate process/Host loss after the Agent finished but before Maka's
    // terminal event was acknowledged to the Plugin.
    await first.dispose();
    const restored = make();
    const projected: PluginExecutorOutputEvent[] = [];
    try {
      const result = await restored.execute(
        f.request('new-user-input'),
        f.context(undefined, (event) => projected.push(event)),
      );
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.code, 'acp_history_gap');
      assert.deepEqual(projected, []);
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
        'history_gap',
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await f.dispose();
  }
});

test('real filesystem callbacks reject a symlink escape and permit workspace files', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'maka-acp-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(f.root, 'escape.txt'));
    const result = await f.executor.execute(f.request('files'), f.context());
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completion');
    assert.deepEqual(JSON.parse(result.text), { write: true, read: 'fixture', escape: true });
    assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'fixture');
  } finally {
    await f.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('file writes reject existing and dangling links outside the workspace', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'maka-acp-outside-'));
  try {
    const existing = join(outside, 'existing.txt');
    const missing = join(outside, 'missing.txt');
    await writeFile(existing, 'unchanged');
    await symlink(existing, join(f.root, 'existing-link.txt'));
    await symlink(missing, join(f.root, 'dangling-link.txt'));
    await symlink('dangling-link.txt', join(f.root, 'indirect-link.txt'));
    for (const name of ['existing-link.txt', 'dangling-link.txt', 'indirect-link.txt']) {
      const result = await f.executor.execute(
        f.request(
          `write:${JSON.stringify({ path: join(f.root, name), content: 'must not escape' })}`,
        ),
        f.context(),
      );
      assert.equal(result.status, 'completed');
      if (result.status !== 'completed') throw new Error('Expected completion');
      assert.ok(JSON.parse(result.text).error, name);
      assert.equal(await readFile(existing, 'utf8'), 'unchanged');
      await assert.rejects(readFile(missing), { code: 'ENOENT' });
    }
    // Refusing a file callback must not lose the retained conversation.
    assert.equal((await f.executor.execute(f.request('after'), f.context())).status, 'completed');
  } finally {
    await f.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('file writes create and truncate regular files but reject links inside the workspace', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'target.txt');
    const write = async (path: string, content: string) => {
      const result = await f.executor.execute(
        f.request(`write:${JSON.stringify({ path, content })}`),
        f.context(),
      );
      if (result.status !== 'completed') throw new Error('Expected completion');
      assert.deepEqual(JSON.parse(result.text).result, {});
    };
    await write(target, 'long initial content');
    assert.equal(await readFile(target, 'utf8'), 'long initial content');
    await write(target, 'short');
    assert.equal(await readFile(target, 'utf8'), 'short');
    const link = join(f.root, 'internal-link.txt');
    await symlink(target, link);
    const result = await f.executor.execute(
      f.request(`write:${JSON.stringify({ path: link, content: 'via link' })}`),
      f.context(),
    );
    if (result.status !== 'completed') throw new Error('Expected completion');
    assert.ok(JSON.parse(result.text).error);
    assert.equal(await readFile(target, 'utf8'), 'short');
  } finally {
    await f.dispose();
  }
});

for (const metadata of [
  { title: 'Long title '.repeat(1000), name: 'edit'.repeat(100) },
  { title: 'Edit\0file\r\nnow', name: 'edit\0\r\nfile' },
  { title: 'Edit file', name: '\0\r\n' },
]) {
  test(`real tool metadata is bounded without losing activity (${metadata.name.length} characters)`, async () => {
    const f = await fixture();
    const root = new Context();
    const executors = new PluginExecutorService(root);
    root
      .extend({
        maka: { rootId: 'profile', packageId: 'fixture', entryId: 'stdio', generation: 1 },
      })
      .executors.register(f.executor);
    const backend = new PluginExecutorBackend({
      sessionId: 'task',
      cwd: f.root,
      binding: executors.bind('task', f.executor.id),
    });
    try {
      const events = [];
      for await (const event of backend.send({
        turnId: 'metadata',
        text: `metadata:${JSON.stringify(metadata)}`,
      }))
        events.push(event);
      const start = events.find((event) => event.type === 'tool_start');
      const result = events.find((event) => event.type === 'tool_result');
      assert.ok(start && start.type === 'tool_start', 'tool activity must reach the transcript');
      assert.ok(result && result.type === 'tool_result');
      assert.equal(result.toolUseId, start.toolUseId);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.content, { kind: 'text', text: 'edit completed' });
      assert.equal(events.at(-1)?.type, 'complete');
    } finally {
      await backend.dispose();
      await root.fiber.dispose();
      await f.dispose();
    }
  });
}

for (const newline of ['\n', '\r\n']) {
  test(`real ${JSON.stringify(newline)} file diffs survive executor validation and backend projection`, async () => {
    const f = await fixture();
    const root = new Context();
    const executors = new PluginExecutorService(root);
    root
      .extend({
        maka: { rootId: 'profile', packageId: 'fixture', entryId: 'stdio', generation: 1 },
      })
      .executors.register(f.executor);
    const backend = new PluginExecutorBackend({
      sessionId: 'task',
      cwd: f.root,
      binding: executors.bind('task', f.executor.id),
    });
    try {
      const events = [];
      for await (const event of backend.send({
        turnId: 'edit',
        text: `diff:${JSON.stringify(newline)}`,
      }))
        events.push(event);
      const result = events.find((event) => event.type === 'tool_result');
      assert.ok(result && result.type === 'tool_result');
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.content, {
        kind: 'file_diff',
        paths: ['edited.txt'],
        diff: '--- a/edited.txt\n+++ b/edited.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      });
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(await readFile(join(f.root, 'edited.txt'), 'utf8'), `new${newline}`);
    } finally {
      await backend.dispose();
      await root.fiber.dispose();
      await f.dispose();
    }
  });
}

test('real cancellation settles before follow-up; crash makes the task history-only', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const result = await f.executor.execute(
      f.request('wait'),
      f.context(abort.signal, () => abort.abort()),
    );
    assert.equal(result.status, 'cancelled');
    assert.equal((await f.executor.execute(f.request('after'), f.context())).status, 'completed');
    assert.equal((await f.executor.execute(f.request('crash'), f.context())).status, 'failed');
    assert.equal(
      (await f.executor.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
      'history_only',
    );
    assert.equal(
      (await f.executor.execute(f.request('never-replay'), f.context())).status,
      'failed',
    );
  } finally {
    await f.dispose();
  }
});

test('disposing a real retained process also terminates its helper', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture();
  try {
    const result = await f.executor.execute(f.request('helper'), f.context());
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completion');
    const pid = Number(result.text);
    assert.ok(pid > 0);
    await f.executor.dispose();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.dispose();
  }
});

test('an unresponsive cancel is bounded, records timeout and loses the process', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const result = await f.executor.execute(
      f.request('ignore-cancel'),
      f.context(abort.signal, () => abort.abort()),
    );
    assert.deepEqual(result, { status: 'cancelled', reason: 'timeout' });
    assert.equal(
      (await f.executor.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
      'history_only',
    );
  } finally {
    await f.dispose();
  }
});

test('retiring one conversation cleans its helper after the parent has crashed', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture();
  try {
    const result = await f.executor.execute(f.request('helper'), f.context());
    if (result.status !== 'completed') throw new Error('Expected helper');
    const pid = Number(result.text);
    await f.executor.execute(f.request('crash'), f.context());
    await f.executor.disposeConversation('task');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.dispose();
  }
});
