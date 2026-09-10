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
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('interactive composer shares prompt text without sharing turn metadata or extending ownership', () => {
  const server = (name: string) => new URL(`../server/${name}.js`, import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
    import { randomUUID } from 'node:crypto';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setFlagsFromString, writeHeapSnapshot } from 'node:v8';
    import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
    const { createInteractiveRunComposer } = await import(process.argv[1]);
    const { HostSkillCatalogCoordinator } = await import(process.argv[2]);
    const { SkillCatalogRepository } = await import(process.argv[3]);
    // Memory markers follow the base prompt, beyond V8's default 1024-char names.
    setFlagsFromString('--heap-snapshot-string-limit=100000');
    const root = await mkdtemp(join(tmpdir(), 'maka-run-prompt-memory-'));
    const project = join(root, 'project'), home = join(root, 'home'), data = join(root, 'data');
    await Promise.all([project, home, data].map(path => mkdir(path)));
    const catalog = new HostSkillCatalogCoordinator(new SkillCatalogRepository({
      homeDirectory: home, managedSourcesRoot: join(home, '.maka', 'skill-sources'),
      runWithRoot: async operation => operation(data),
    }), { run: async (target, operation) => operation({ target, cwd: target.path, projectId: null }) });
    const ctx = turnId => ({ sessionId: 'session', turnId, cwd: project });
    const collect = async () => {
      for (let i = 0; i < 8; i++) { await new Promise(setImmediate); global.gc(); }
      await new Promise(setImmediate);
    };
    const live = refs => refs.filter(ref => ref.deref()).length;
    const create = (read, skills, workspace = false, extra = {}) => {
      const policy = createDefaultRuntimePolicy(); policy.workspaceInstructions.enabled = workspace;
      return createInteractiveRunComposer({
        runtimePolicy: { revision: 0, policy }, sessionTodo: {},
        skills: skills ?? { readCanonicalModelInventory: async () => ({ revision: 'skills', inventory: [] }) },
        memory: { readPromptProjection: read }, ...extra,
      });
    };
    async function countTexts(marker) {
      await collect();
      const path = writeHeapSnapshot(join(root, 'prompt.heapsnapshot'));
      const heap = JSON.parse(await readFile(path, 'utf8'));
      await rm(path);
      const fields = heap.snapshot.meta.node_fields, width = fields.length;
      const name = fields.indexOf('name'), type = fields.indexOf('type');
      const types = heap.snapshot.meta.node_types[type];
      let count = 0;
      for (let i = 0; i < heap.nodes.length; i += width) {
        const value = heap.strings[heap.nodes[i + name]];
        if (types[heap.nodes[i + type]] === 'string' &&
          value.startsWith('You are Maka, an AI agent') && value.includes(marker)) count++;
      }
      return count;
    }
    async function repeated(changed) {
      const marker = randomUUID(), text = marker + '汉'.repeat(11000);
      const refs = [], revisions = [];
      let reads = 0, traces = 0, previous, first;
      let owner = create(async () => ({
        body: text + (changed ? reads : ''), memoryRevision: 'm' + reads++,
        bundleRevision: 'bundle',
      }));
      for (let i = 0; i < 32; i++) {
        const context = { ...ctx('turn-' + i), emitSkillCatalogTrace: () => traces++ };
        let pending = owner.resolveSystemPrompt(context);
        assert.equal(owner.resolveSystemPrompt(context), pending, 'same-turn Promise');
        let prompt = await pending;
        assert.ok(Object.isFrozen(prompt)); assert.ok(Object.isFrozen(prompt.sourceRevisions));
        refs.push(new WeakRef(prompt)); revisions.push(new WeakRef(prompt.sourceRevisions));
        if (!first) first = prompt;
        if (previous) {
          assert.notEqual(previous, prompt); assert.notEqual(previous.sourceRevisions, prompt.sourceRevisions);
          for (let j = 0; j < previous.sourceRevisions.length; j++)
            assert.notEqual(previous.sourceRevisions[j], prompt.sourceRevisions[j]);
          if (!changed) assert.equal(previous.text, prompt.text);
          else assert.notEqual(previous.text, prompt.text);
        }
        previous = prompt; pending = null; prompt = null;
      }
      assert.equal(reads, 32); assert.equal(traces, 32);
      assert.equal((await owner.resolveSystemPrompt(ctx('turn-0'))), first);
      const currentRevision = previous.sourceRevisions[0].revision;
      first.sourceRevisions[0].revision = 'caller-owned mutation';
      assert.equal(previous.sourceRevisions[0].revision, currentRevision);
      assert.equal(await countTexts(marker), changed ? 32 : 1, 'only equal text shares');
      assert.equal(live(refs), 32); assert.equal(live(revisions), 32);
      first = null; previous = null; owner = null;
      assert.equal(await countTexts(marker), 0, 'released composer text collects');
      assert.equal(live(refs), 0); assert.equal(live(revisions), 0);
    }
    try {
      await catalog.recover();
      await repeated(false); await repeated(true);
      let reads = 0, body = 'MEMORY_BEFORE';
      const owner = create(async () => { reads++; return { body }; }, catalog, true);
      const first = await owner.resolveSystemPrompt(ctx('before'));
      await writeFile(join(project, 'AGENTS.md'), 'WORKSPACE_AFTER');
      const workspace = await owner.resolveSystemPrompt(ctx('workspace'));
      assert.match(workspace.text, /WORKSPACE_AFTER/); assert.notEqual(workspace.text, first.text);
      const skillRoot = join(project, '.maka', 'skills', 'fixture');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, 'SKILL.md'),
        '---\nname: fixture\ndescription: SKILL_AFTER\n---\nFixture instructions\n');
      const skill = await owner.resolveSystemPrompt(ctx('skill'));
      assert.match(skill.text, /SKILL_AFTER/); assert.notEqual(skill.text, workspace.text);
      body = 'MEMORY_AFTER';
      assert.match((await owner.resolveSystemPrompt(ctx('memory'))).text, /MEMORY_AFTER/);
      assert.equal(await owner.resolveSystemPrompt(ctx('before')), first);
      assert.doesNotMatch(first.text, /WORKSPACE_AFTER|SKILL_AFTER|MEMORY_AFTER/);
      assert.equal(reads, 4);
      let attempts = 0;
      const retry = create(async () => { if (++attempts === 1) throw Error('read failed'); return {}; });
      const failed = retry.resolveSystemPrompt(ctx('retry'));
      assert.equal(retry.resolveSystemPrompt(ctx('retry')), failed);
      await assert.rejects(failed, /read failed/);
      assert.notEqual(retry.resolveSystemPrompt(ctx('retry')), failed);
      await retry.resolveSystemPrompt(ctx('retry')); assert.equal(attempts, 2);
      let fifoReads = 0;
      const fifo = create(async () => { fifoReads++; return {}; });
      const oldest = fifo.resolveSystemPrompt(ctx('fifo-0')); await oldest;
      for (let i = 1; i < 100; i++) await fifo.resolveSystemPrompt(ctx('fifo-' + i));
      assert.equal(fifo.resolveSystemPrompt(ctx('fifo-0')), oldest);
      const second = fifo.resolveSystemPrompt(ctx('fifo-1'));
      await fifo.resolveSystemPrompt(ctx('fifo-100'));
      assert.equal(fifoReads, 101); assert.equal(fifo.resolveSystemPrompt(ctx('fifo-1')), second);
      assert.notEqual(fifo.resolveSystemPrompt(ctx('fifo-0')), oldest);
      await fifo.resolveSystemPrompt(ctx('fifo-0')); assert.equal(fifoReads, 102);
      for (const late of [false, true]) {
        const marker = randomUUID(); let calls = 0, gate = Promise.withResolvers();
        const candidate = create(() => {
          if (++calls > 1) return Promise.reject(Error('eviction fixture'));
          return late ? gate.promise : Promise.resolve({ body: marker + '汉'.repeat(11000) });
        });
        let pending = candidate.resolveSystemPrompt(ctx('evicted'));
        if (!late) {
          await pending; assert.equal(await countTexts(marker), 1, 'owned positive control');
          pending = null;
        }
        await Promise.allSettled(Array.from({ length: 101 }, (_, i) =>
          candidate.resolveSystemPrompt(ctx('failure-' + i))));
        if (late) {
          gate.resolve({ body: marker + '汉'.repeat(11000) });
          await pending; assert.equal(await countTexts(marker), 1, 'held late result positive');
          pending = null; gate = null;
        }
        assert.equal(await countTexts(marker), 0, 'eviction releases text; late=' + late);
        await assert.rejects(candidate.resolveSystemPrompt(ctx('evicted')), /eviction fixture/);
      }
      const child = create(async () => { throw Error('child read Memory'); }, undefined, false,
        { childInstruction: 'Child role' });
      assert.match((await child.resolveSystemPrompt(ctx('child'))).text, /Child role/);
    } finally { await catalog.close(); await rm(root, { recursive: true, force: true }); }
  `,
      server('interactive-run-composer'),
      server('skill-catalog-coordinator'),
      server('skill-catalog-repository'),
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
