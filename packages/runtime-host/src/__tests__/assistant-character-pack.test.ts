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
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterPack, CHARACTER_PACK_GUIDE } from '../assistant/bot/character-pack.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), '角色包-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, pack: new CharacterPack(root) };
}

test('pack creates editable Markdown and preserves user changes across restart', (t) => {
  const { root, pack } = fixture(t);
  assert.equal(pack.readDocument('guide').content, CHARACTER_PACK_GUIDE);
  const persona = pack.readDocument('persona');
  pack.writeDocument('persona', '# 名字\n小橘\n喜欢简洁、有趣的日常交流。', persona.revision);
  const restarted = new CharacterPack(root);
  assert.match(restarted.prompt(), /小橘/);
  assert.doesNotMatch(restarted.prompt(), /不需要每次创作/);
  assert.equal(restarted.list().total, 0);
  assert.match(restarted.prompt(), /GUIDE.md/);
});

test('persona accepts 200 lines including CRLF and rejects excess without truncation or replacement', (t) => {
  const { pack } = fixture(t);
  const initial = pack.readDocument('persona');
  const text = Array(200).fill('风格').join('\r\n') + '\r\n';
  const saved = pack.writeDocument('persona', text, initial.revision);
  assert.equal(pack.readDocument('persona').content, text);
  assert.throws(
    () => pack.writeDocument('persona', text + '第 201 行', saved.revision),
    /200 lines/,
  );
  assert.equal(pack.readDocument('persona').revision, saved.revision);
  assert.throws(() => pack.writeDocument('persona', '很'.repeat(24000), saved.revision), /24 KiB/);
});

test('stale document edits cannot overwrite an external edit; invalid external persona does not break Bot prompts', (t) => {
  const { pack } = fixture(t);
  const initial = pack.readDocument('persona');
  writeFileSync(initial.path, '外部编辑');
  assert.throws(() => pack.writeDocument('persona', 'stale', initial.revision), /changed/);
  assert.match(pack.prompt(), /外部编辑/);
  writeFileSync(initial.path, Array(201).fill('内容').join('\n'));
  assert.match(pack.prompt(), /暂不可用/);
  assert.doesNotMatch(pack.prompt(), /内容/);
  assert.equal(readFileSync(initial.path, 'utf8').split('\n').length, 201);
  const invalid = pack.readDocument('persona');
  pack.writeDocument('persona', '修复的人格', invalid.revision);
  assert.match(pack.prompt(), /修复的人格/);
});

test('images keep independent bytes, deduplicate retries, paginate and survive restart', (t) => {
  const { root, pack } = fixture(t);
  const info = { title: '庆祝贴纸', kind: 'sticker' as const, usage: '事情做好以后' };
  const first = pack.addImage(info, png);
  assert.equal(first.reused, false);
  assert.equal(pack.addImage(info, png).reused, true);
  pack.addImage({ ...info, title: '另一张' }, Buffer.concat([png, Buffer.from([0])]));
  assert.equal(pack.list(0, 1).nextOffset, 1);
  assert.equal(pack.list(1, 1).nextOffset, null);
  assert.equal(pack.list().total, 2);
  const restarted = new CharacterPack(root);
  assert.deepEqual(Buffer.from(restarted.image(first.asset.id).bytes), png);
  assert.equal(restarted.asset(first.asset.id).title, info.title);
  assert.equal(JSON.stringify(first).includes(png.toString('base64')), false);
});

test('source and attribution persist separately without filling the sticker shelf or search descriptions', (t) => {
  const { root, pack } = fixture(t);
  const saved = pack.addImage(
    {
      title: '无语',
      kind: 'sticker',
      usage: '想吐槽时接话',
      sourceUrl: 'https://example.com/reaction.png',
      attribution: 'Fixture artist, fixture license',
    },
    png,
  );
  const restarted = new CharacterPack(root);
  assert.equal(restarted.asset(saved.asset.id).sourceUrl, 'https://example.com/reaction.png');
  assert.equal(restarted.asset(saved.asset.id).attribution, 'Fixture artist, fixture license');
  assert.doesNotMatch(restarted.prompt(), /Fixture artist|example.com/);
  assert.doesNotMatch(JSON.stringify(restarted.stickers('无语')), /Fixture artist|example.com/);
  restarted.updateAsset(saved.asset.id, { attribution: 'Updated fixture credit' });
  assert.equal(restarted.asset(saved.asset.id).attribution, 'Updated fixture credit');
  assert.equal(restarted.asset(saved.asset.id).usage, '想吐槽时接话');
});

test('corrupt manifests and image bytes are not silently overwritten', (t) => {
  const { root, pack } = fixture(t);
  const saved = pack.addImage({ title: '头像', kind: 'avatar', usage: '' }, png);
  writeFileSync(saved.asset.path, 'corrupt');
  assert.throws(() => pack.image(saved.asset.id), /changed/);
  assert.throws(() => pack.addImage({ title: 'retry', kind: 'avatar', usage: '' }, png), /changed/);
  const manifest = join(pack.directory, 'manifest.json');
  writeFileSync(manifest, '{broken');
  const restarted = new CharacterPack(root);
  assert.throws(() => restarted.list());
  assert.equal(readFileSync(manifest, 'utf8'), '{broken');
});

test('invalid images and traversal references cannot become assets', (t) => {
  const { pack } = fixture(t);
  assert.throws(() =>
    pack.addImage({ title: 'fake', kind: 'image', usage: '' }, Buffer.from('<svg/>')),
  );
  assert.throws(() =>
    pack.addImage(
      { title: 'large', kind: 'image', usage: '' },
      Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
    ),
  );
  assert.throws(() => pack.image('../../persona.md'));
  assert.equal(pack.list().total, 0);
});

test('pack documents and assets cannot read through symlinks', (t) => {
  const { root, pack } = fixture(t);
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'private outside contents');
  const persona = join(pack.directory, 'persona.md');
  rmSync(persona);
  symlinkSync(outside, persona);
  assert.throws(() => pack.readDocument('persona'));
  assert.doesNotMatch(pack.prompt(), /private outside/);
  const saved = pack.addImage({ title: 'image', kind: 'image', usage: '' }, png);
  rmSync(saved.asset.path);
  symlinkSync(outside, saved.asset.path);
  assert.throws(() => pack.image(saved.asset.id));
  assert.equal(readFileSync(outside, 'utf8'), 'private outside contents');
});

test('Bot can revise its own guide and asset metadata, remove assets and add them again', (t) => {
  const { root, pack } = fixture(t);
  const guide = pack.readDocument('guide');
  pack.writeDocument('guide', '# 我的维护习惯\n自己尝试不同风格。', guide.revision);
  const saved = pack.addImage({ title: '初稿', kind: 'image', usage: '试试' }, png);
  const updated = pack.updateAsset(saved.asset.id, { title: '日常头像', kind: 'avatar' });
  assert.equal(updated.asset.usage, '试试', 'omitted fields keep their existing values');
  const restarted = new CharacterPack(root);
  assert.equal(restarted.asset(saved.asset.id).title, '日常头像');
  assert.match(restarted.readDocument('guide').content, /我的维护习惯/);
  assert.equal(restarted.removeAsset(saved.asset.id).removed, true);
  assert.equal(restarted.list().total, 0);
  assert.equal(restarted.removeAsset(saved.asset.id).removed, false);
  assert.throws(() => restarted.image(saved.asset.id), /Unknown/);
  assert.equal(restarted.addImage({ title: '再用', kind: 'avatar', usage: '' }, png).reused, false);
});

test('sticker shelf stays stable across calls and restarts, rotates on persona or compaction and never pads', (t) => {
  const { root, pack } = fixture(t);
  for (let i = 0; i < 25; i++)
    pack.addImage(
      { title: `表情 ${i}`, kind: 'sticker', usage: '开心 庆祝' },
      Buffer.concat([png, Buffer.from([i])]),
    );
  const selected = () =>
    JSON.parse(readFileSync(join(pack.directory, 'sticker-shelf.json'), 'utf8')).ids as string[];
  const first = pack.prompt('worker', 'checkpoint-1');
  const ids = selected();
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  assert.equal(pack.prompt('worker', 'checkpoint-1'), first);
  const restarted = new CharacterPack(root);
  assert.equal(restarted.prompt('worker', 'checkpoint-1'), first);
  assert.equal(
    restarted.prompt('worker'),
    first,
    'missing checkpoint lookup retains previous selection',
  );
  const persona = restarted.readDocument('persona');
  restarted.writeDocument('persona', '新名字', persona.revision);
  restarted.prompt('worker', 'checkpoint-1');
  const changed = selected();
  assert.equal(changed.filter((id) => ids.includes(id)).length, 0);
  restarted.prompt('worker', 'checkpoint-2');
  const compacted = selected();
  assert.equal(compacted.filter((id) => changed.includes(id)).length, 0);
  restarted.removeAsset(compacted[0]!);
  assert.ok(!restarted.prompt('worker', 'checkpoint-2').includes(compacted[0]!));
  for (const asset of restarted.list().assets.slice(3)) restarted.removeAsset(asset.id);
  restarted.prompt('worker', 'checkpoint-2');
  assert.equal(selected().length, 3);
  for (const asset of restarted.list().assets) restarted.removeAsset(asset.id);
  assert.doesNotMatch(restarted.prompt('worker', 'checkpoint-2'), /可用表情素材/);
});

test('sticker lookup returns usable paths and concise matches, excludes avatars and caps random results', (t) => {
  const { pack } = fixture(t);
  pack.addImage({ title: '头像', kind: 'avatar', usage: '开心' }, png);
  for (let i = 0; i < 12; i++)
    pack.addImage(
      { title: `庆祝 ${i}`, kind: 'sticker', usage: i === 0 ? '开心 击掌' : '休息 累瘫' },
      Buffer.concat([png, Buffer.from([i])]),
    );
  const found = pack.stickers('开心 击掌');
  assert.equal(found.total, 1);
  assert.equal(found.items[0]!.title, '庆祝 0');
  assert.ok(readFileSync(found.items[0]!.path).length);
  assert.equal(pack.stickers().items.length, 10);
  assert.equal(pack.stickers('不存在').items.length, 0);
  assert.equal(JSON.stringify(found).includes(png.toString('base64')), false);
});

test('only the exact old default persona and guide are upgraded', (t) => {
  const { root, pack } = fixture(t);
  writeFileSync(
    pack.readDocument('persona').path,
    '# 身份\n你是用户的个人助手。你可以为自己选择名字、形象和表达方式，在与用户相处中逐渐调整。\n\n# 表达\n自然、直接地交流，让表达适合当前的事情与用户的心情。\n',
  );
  writeFileSync(
    pack.readDocument('guide').path,
    '# 角色包维护指南\n\n这个包保存你的身份、表达方式和可复用素材。它不是任务状态或用户记忆库。\n\n## 使用\n- persona.md 是人格文档，最多 200 行；内容自动进入你的模型指令，修改后下次组装指令时生效。\n- 本指南按需通过 AssistantCharacterPack 的 read 操作读取，不会整份自动注入。\n- list 查看素材目录，asset 查看一项素材。图片内容不塞进模型提示词。\n- AssistantStickerSearch 按名称或用途关键词查表情，不填 query 时随机看看；返回的 imageUrl 可用于 SendUser 的 Markdown 图片。表情素材用 kind=sticker 保存。\n- 指令中会放最多 10 张表情的简短目录，数量不足不凑数；想用其他表情随时查询，不必为了使用表情而使用。\n- 先读再写文档；write 携带 read 返回的 revision，防止覆盖其他编辑。\n\n## 创作\n你可以根据与用户的相处，自主创作和使用图片、表情、装扮等，让表达更贴切，也给用户一点意外的乐趣。不需要每次创作，也不必每次先询问。\n- 需要新图时，使用当前可用的生图、找图或委派能力；本接口只保存素材，不生成图片。\n- 根据真实结果判断是否生成成功，先查看图片，再决定是否收进包里。\n- add_image 的 source 填当前工具会话工作目录内的图片路径，或可公开访问的 HTTP(S) 图片网址。\n- 填写简短的 title、kind 和 usage，说明这是什么、适合怎么用，不写长篇执行记录。\n- 素材保存独立副本；返回稳定的 assetId，同一图片重复登记不会增加副本。\n- AssistantCharacterPack 的 set_avatar 操作用 assetId 设置已保存图片为头像，也可传 image 保存并使用新图，或 emoji 作为无图形象；background 可设背景色。保存素材不会自动换头像或发消息。\n- 聊天展示用 asset 或表情查询返回的 imageUrl，格式为 ![说明](imageUrl)，沿用已有附件能力；assetId 和角色包本地路径不是可发送的图片网址。不要宣称用户看到了尚未实际展示的素材。\n- 创作或展示能力不可用时，正常继续聊天，不要假装已经完成。\n\n## 维护\n- persona.md 写你是谁、如何表达；GUIDE.md 写如何使用和维护素材。不要把这里变成用户事实库、待办表或任务进度表。\n- 这个包由你自主维护。你可以修改名字、人格、表达风格、本指南和素材组织方式，不需要等用户逐项安排，也不必为日常维护反复征求许可。用户明确表达的偏好优先。\n- 根据相处体验尝试新的表达和形象，觉得不合适可以再改。write 可改 persona 和 guide；update_asset 可改素材标题、分类和用途；remove_asset 移除不用的素材。移除素材不会撤回已发送内容，也不会清空已经设置的头像。\n- 不在 manifest.json 中手工登记不存在的文件，使用接口登记素材。图片保存在 assets/ 中。\n- 第一版支持 PNG、JPEG、WebP、GIF（沿用头像图片校验和 2 MiB 上限）。宠物动画包和声音接口尚未接入，不要假装可以播放。\n',
  );
  const upgraded = new CharacterPack(root);
  assert.equal(upgraded.readDocument('persona').content, '');
  assert.equal(upgraded.readDocument('guide').content, CHARACTER_PACK_GUIDE);
  upgraded.writeDocument('guide', '# 我的指南', upgraded.readDocument('guide').revision);
  assert.equal(new CharacterPack(root).readDocument('guide').content, '# 我的指南');
});
