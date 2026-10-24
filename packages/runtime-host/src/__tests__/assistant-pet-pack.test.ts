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
import { mkdtemp, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createImageFileReader } from '@maka/runtime/image-file-reader';
import { createSettingsStore } from '@maka/storage/settings-store';
import { createPetPackStore } from '@maka/storage/pet-pack-store';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import type { AssistantModuleServices } from '../assistant/service.js';
import { initializePetPack } from '../assistant/bot/pet-pack.js';
import { createAssistantPetPacks } from '../server/assistant-pet-packs.js';
import { BOT_TOOLS } from '../assistant/bot/capabilities.js';
import { DISCOVERY_EXCLUDED_TOOLS } from '../assistant/index-initiative/discovery-capabilities.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
function manifest() {
  return {
    schema: 'maka.pet/v1',
    id: 'test.pet',
    displayName: '测试宠物',
    spriteSheet: {
      path: 'assets/sprites.png',
      format: 'png',
      frameWidth: 1,
      frameHeight: 1,
      columns: 1,
      rows: 1,
      frameCount: 1,
    },
    animations: Object.fromEntries(
      ['idle', 'working', 'needs-input', 'ready', 'blocked'].map((state) => [
        state,
        { frames: [0], fps: 1, loop: true },
      ]),
    ),
  };
}
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), '宠物包接口-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '本地图集.png');
  await writeFile(path, png);
  const reader = createImageFileReader();
  const reads: string[] = [];
  const readImage = (id: string, path: string, signal: AbortSignal) => {
    reads.push(id);
    return reader({
      path,
      cwd: root,
      imagePurpose: 'pet',
      abortSignal: signal,
    });
  };
  const state = join(root, 'host-state');
  const service = createAssistantPetPacks(state, readImage);
  let tool!: MakaTool;
  initializePetPack({
    petPacks: service,
    tools: {
      register: (value) => {
        tool = value;
      },
    },
  } as AssistantModuleServices);
  const invoke = (input: unknown, signal = new AbortController().signal) =>
    tool.impl(input, {
      sessionId: 'delegated-worker',
      cwd: root,
      abortSignal: signal,
    } as any) as Promise<any>;
  return { root, path, state, service, reads, tool, invoke, readImage };
}

test('Agent tool installs in desktop store, preserves assets and selection, and survives restart', async (t) => {
  const f = await fixture(t);
  const settings = createSettingsStore(f.state);
  await settings.update({ personalization: { selectedPetId: 'existing.pet' } });
  const before = await settings.get();
  const input = {
    action: 'create',
    manifest: manifest(),
    spriteSheetPath: f.path,
  };
  const result = await f.invoke(input);
  assert.equal(result.installed, true);
  assert.equal(result.reused, false);
  assert.equal(result.selectionChanged, false);
  assert.deepEqual(f.reads, ['delegated-worker']);
  const desktop = createPetPackStore(f.state);
  assert.equal((await desktop.list())[0].displayName, '测试宠物');
  assert.deepEqual(Buffer.from((await desktop.readSpriteSheet('test.pet'))!.bytes), png);
  const restarted = createAssistantPetPacks(f.state, f.readImage);
  assert.equal(
    (await restarted.create('delegated-worker', input, new AbortController().signal)).reused,
    true,
  );
  assert.equal((await f.invoke({ action: 'list' })).packs.length, 1);
  assert.deepEqual(await settings.get(), before);
  assert.ok(!JSON.stringify(result).includes(png.toString('base64')));
});

test('concurrent identical requests reuse one installation, conflicting IDs preserve existing pack', async (t) => {
  const f = await fixture(t);
  const input = {
    action: 'create',
    manifest: manifest(),
    spriteSheetPath: f.path,
  };
  const results = await Promise.all([f.invoke(input), f.invoke(input)]);
  assert.deepEqual(results.map((r) => r.reused).sort(), [false, true]);
  await assert.rejects(
    f.invoke({ ...input, manifest: { ...manifest(), displayName: '冲突' } }),
    /different content/,
  );
  await writeFile(f.path, Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(f.invoke(input), /different content/);
  assert.deepEqual(
    Buffer.from((await createPetPackStore(f.state).readSpriteSheet('test.pet'))!.bytes),
    png,
  );
});

test('invalid manifest, dimensions and oversized images never publish a partial pack', async (t) => {
  const f = await fixture(t);
  const base = manifest();
  for (const invalid of [
    { ...base, animations: { idle: base.animations.idle } },
    { ...base, spriteSheet: { ...base.spriteSheet, path: '../escape.png' } },
    { ...base, spriteSheet: { ...base.spriteSheet, frameWidth: 2 } },
  ])
    await assert.rejects(
      f.invoke({
        action: 'create',
        manifest: invalid,
        spriteSheetPath: f.path,
      }),
    );
  await writeFile(f.path, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(
    f.invoke({ action: 'create', manifest: base, spriteSheetPath: f.path }),
    /4 MiB/,
  );
  assert.equal((await f.service.list()).length, 0);
});

test('tool reads respect Session filesystem boundaries and cancellation', async (t) => {
  const f = await fixture(t);
  const input = {
    action: 'create',
    manifest: manifest(),
    spriteSheetPath: join(f.root, '..', 'outside.png'),
  };
  await assert.rejects(f.invoke(input), /denied|outside|allowed/i);
  await symlink(join(f.root, '..', 'outside.png'), join(f.root, 'redirect.png'));
  await assert.rejects(f.invoke({ ...input, spriteSheetPath: join(f.root, 'redirect.png') }));
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  await assert.rejects(f.invoke({ ...input, spriteSheetPath: f.path }, abort.signal), /cancelled/);
  assert.equal((await f.service.list()).length, 0);
});

test('requirements are directly available; creation has explicit parameters and is excluded from discovery', async (t) => {
  const f = await fixture(t);
  assert.equal(f.tool.discovery, 'direct');
  assert.equal(f.tool.executionSemantics, 'exclusive_step');
  assert.equal(z.toJSONSchema(f.tool.parameters as z.ZodType).type, 'object');
  assert.ok(BOT_TOOLS.has('AssistantPetPack'));
  assert.ok(DISCOVERY_EXCLUDED_TOOLS.has('AssistantPetPack'));
  const specs = await f.invoke({ action: 'requirements' });
  assert.match(specs.requirements, /spriteSheetPath/);
  assert.match(specs.requirements, /needs-input/);
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.invoke({ action: 'create' }), /requires/);
});

test('select validates the installed pack, updates desktop settings, and survives service restart', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ action: 'select', petId: 'missing' }), /not installed/);
  assert.equal((await f.invoke({ action: 'status' })).configured, false);
  await f.invoke({ action: 'create', manifest: manifest(), spriteSheetPath: f.path });
  await f.invoke({ action: 'select', petId: 'test.pet' });
  const settings = await createSettingsStore(f.state).get();
  assert.equal(settings.personalization.selectedPetId, 'test.pet');
  assert.equal(settings.personalization.petMode, 'assistant');
  const restarted = createAssistantPetPacks(f.state, f.readImage);
  assert.equal((await restarted.status()).configured, true);
  await assert.rejects(f.invoke({ action: 'select', petId: 'missing' }));
  assert.equal((await restarted.status()).selectedPetId, 'test.pet');
});


test('idle variants survive installation and service restart', async (t) => {
  const f = await fixture(t);
  const variants = [{frames:[0],fps:2,loop:true},{frames:[0],fps:3,loop:false}];
  const result = await f.invoke({action:'create', manifest:{...manifest(), idleVariants:variants}, spriteSheetPath:f.path});
  assert.equal(result.idleAnimationCount, 3);
  const restarted = createAssistantPetPacks(f.state, f.readImage);
  assert.deepEqual((await restarted.list())[0].idleVariants, variants);
});
