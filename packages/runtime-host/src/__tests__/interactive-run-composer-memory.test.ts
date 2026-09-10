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

test('interactive composer shares only identical owned snapshots and preserves turn history', () => {
  const server = (name: string) => new URL(`../server/${name}.js`, import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setImmediate } from 'node:timers/promises';
    import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
    import { createInteractiveRunComposer } from ${JSON.stringify(server('interactive-run-composer'))};
    import { HostSkillCatalogCoordinator } from ${JSON.stringify(server('skill-catalog-coordinator'))};
    import { SkillCatalogRepository } from ${JSON.stringify(server('skill-catalog-repository'))};
    const root = await mkdtemp(join(tmpdir(), 'maka-composer-memory-'));
    const project = join(root, 'project'), home = join(root, 'home'), data = join(root, 'data');
    const skillRoot = join(project, '.maka', 'skills', 'fixture');
    await Promise.all([mkdir(skillRoot, { recursive: true }), mkdir(home), mkdir(data)]);
    const catalog = new HostSkillCatalogCoordinator(new SkillCatalogRepository({
      homeDirectory: home, managedSourcesRoot: join(home, '.maka', 'skill-sources'),
      runWithRoot: async operation => operation(data),
    }), { run: async (target, operation) => operation({ target, cwd: target.path, projectId: null }) });
    const body = version => '---\nname: Fixture\ndescription: Memory fixture\nallowed-tools: [Skill]\n---\n' +
      'VERSION_' + version + '_' + 'x'.repeat(256 * 1024) + '\n';
    const writeVersion = version => writeFile(join(skillRoot, 'SKILL.md'), body(version));
    const ctx = (turnId, cwd = project) => ({ sessionId: 'session', turnId, cwd });
    const collect = async () => {
      for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
      await setImmediate();
    };
    const live = refs => refs.filter(ref => ref.deref()).length;
    const freeze = value => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze); Object.freeze(value);
      }
      return value;
    };
    const assertFrozen = value => {
      if (value && typeof value === 'object') {
        assert.ok(Object.isFrozen(value)); Object.values(value).forEach(assertFrozen);
      }
    };
    const create = readCanonicalModelInventory => {
      const policy = createDefaultRuntimePolicy(); policy.workspaceInstructions.enabled = false;
      const composer = createInteractiveRunComposer({
        runtimePolicy: { revision: 0, policy }, skills: { readCanonicalModelInventory },
        memory: {}, sessionTodo: {}, childInstruction: 'Fixture',
      });
      const skill = composer.tools.find(tool => tool.name === 'Skill'); assert.ok(skill);
      return { composer, load: (turn, cwd = project) => skill.impl({ name: 'fixture' }, ctx(turn, cwd)) };
    };
    try {
      await catalog.recover(); await writeVersion('base');
      const base = await catalog.readCanonicalModelInventory({ projectRoot: project });
      assert.equal(base.inventory.length, 1); assert.ok(base.diagnostics.length);
      assertFrozen(base);
      assert.throws(() => base.inventory[0].declaredTools.push('mutation'), TypeError);
      assert.throws(() => { base.diagnostics[0].issues[0].message = 'mutation'; }, TypeError);
      for (const changed of [false, true]) {
        const refs = [], results = [], revisions = new Set(); let reads = 0;
        let owner = create(async input => {
          reads++; const snapshot = await catalog.readCanonicalModelInventory(input);
          assertFrozen(snapshot); revisions.add(snapshot.revision);
          refs.push(new WeakRef(snapshot)); return snapshot;
        });
        for (let i = 0; i < 32; i++) {
          if (changed) await writeVersion(i);
          await (async () => {
            const loaded = await owner.load('turn-' + i); assert.equal(loaded.ok, true);
            results.push(new WeakRef(loaded));
            const prompt = await owner.composer.resolveSystemPrompt(ctx('turn-' + i));
            assert.ok(prompt.sourceRevisions.some(item => item.id === 'skill-catalog'));
          })();
        }
        assert.equal(reads, 32); assert.equal(revisions.size, changed ? 32 : 1);
        await collect(); assert.equal(live(results), 0, 'completed tool results collect');
        assert.equal(live(refs), changed ? 32 : 1, 'only identical snapshots share');
        const old = await owner.load('turn-0');
        assert.match(old.skill.instructions, changed ? /VERSION_0_/ : /VERSION_base_/);
        assert.equal(reads, 32);
        owner = null; await collect(); assert.equal(live(refs), 0, 'composer release');
      }
      const workspaceOwner = create(input => catalog.readCanonicalModelInventory(input));
      const original = await workspaceOwner.load('workspace-a');
      const otherProject = join(root, 'other'); await mkdir(otherProject);
      assert.equal((await workspaceOwner.load('workspace-b', otherProject)).ok, false);
      assert.deepEqual(await workspaceOwner.load('workspace-a'), original);

      // Hold the revision fixed while varying fields omitted from its canonical facts.
      const variants = [
        s => { s.projectRoot += '-other'; },
        s => { s.inventory[0].path += '-other'; },
        s => { s.inventory[0].discoveryRoot += '-other'; },
        s => { s.inventory[0].content += ' changed'; },
        s => { s.inventory[0].description += ' changed'; },
        s => { s.inventory[0].enabled = false; },
        s => { s.inventory[0].pinned = true; },
        s => { s.inventory[0].declaredTools.push('SkillSearch'); },
        s => { s.inventory[0].requiredTools.push('MissingTool'); },
        s => { s.inventory[0].requiredCapabilities.push('missing'); },
        s => { s.inventory.reverse(); },
        s => { s.diagnostics[0].path += '-other'; },
        s => { s.diagnostics[0].issues[0].message += ' changed'; },
        s => { s.discoveryDiagnostics[0].path += '-other'; },
        s => { s.discoveryDiagnostics.reverse(); },
      ];
      const comparisonBase = structuredClone(base);
      comparisonBase.inventory.push({ ...structuredClone(base.inventory[0]), id: 'second', ref: 'second' });
      comparisonBase.discoveryDiagnostics = [0, 1].map(i => ({ path: join(root, String(i)),
        scope: 'user', source: 'agents', precedence: i, reason: 'read_failed' }));
      for (const variant of variants) {
        const refs = [];
        const owner = create(async () => {
          const value = structuredClone(comparisonBase);
          if (refs.length) variant(value);
          refs.push(new WeakRef(value)); return freeze(value);
        });
        await owner.load('first'); await owner.load('second'); await collect();
        assert.equal(live(refs), 2, 'same revision must preserve ' + variant.toString());
        await owner.load('first');
      }
      const copy = revision => freeze({ ...structuredClone(base), revision });
      let failures = 1, retryReads = 0;
      const retry = create(async () => {
        retryReads++; if (failures-- > 0) throw Error('read failure'); return copy('retry');
      });
      await assert.rejects(retry.load('retry'), /read failure/);
      assert.equal((await retry.load('retry')).ok, true); assert.equal(retryReads, 2);
      const deferred = () => Promise.withResolvers();
      const pending = [deferred(), deferred()]; let concurrentReads = 0;
      const concurrent = create(() => pending[concurrentReads++].promise);
      const slow = concurrent.load('slow'), same = concurrent.load('slow');
      const prompt = concurrent.composer.resolveSystemPrompt(ctx('slow'));
      const fast = concurrent.load('fast'); assert.equal(concurrentReads, 2);
      const newer = structuredClone(base); newer.inventory[0].content = 'newer';
      pending[1].resolve(freeze({ ...newer, revision: 'newer' }));
      assert.equal((await fast).skill.instructions, 'newer'); pending[0].resolve(copy('older'));
      assert.deepEqual(await slow, await same);
      assert.ok((await prompt).sourceRevisions.some(item => item.revision === 'older'));
      assert.equal((await concurrent.load('fast')).skill.instructions, 'newer');
      let historyReads = 0;
      const history = create(async () => copy('history-' + historyReads++));
      for (let i = 0; i < 101; i++) await history.load('history-' + i);
      await history.load('history-1'); assert.equal(historyReads, 101);
      await history.load('history-0'); assert.equal(historyReads, 102);

      for (const late of [false, true]) {
        const refs = []; let first = true, deferredRead = deferred();
        const owner = create(() => {
          if (!first) return Promise.reject(Error('eviction fixture'));
          first = false;
          if (late) return deferredRead.promise;
          const value = copy('evicted'); refs.push(new WeakRef(value));
          return Promise.resolve(value);
        });
        let firstLoad = owner.load('evicted');
        if (!late) { await firstLoad; firstLoad = null; }
        await Promise.allSettled(Array.from({ length: 101 }, (_, i) => owner.load('failure-' + i)));
        if (late) {
          await (async () => {
            const value = copy('late'); refs.push(new WeakRef(value));
            deferredRead.resolve(value); assert.equal((await firstLoad).ok, true);
          })();
          firstLoad = null; deferredRead = null;
        }
        await collect(); assert.equal(live(refs), 0, 'eviction releases owner; late=' + late);
        await assert.rejects(owner.load('evicted'), /eviction fixture/);
      }
    } finally { await catalog.close(); await rm(root, { recursive: true, force: true }); }
  `,
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
