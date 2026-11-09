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

import { qt } from '../../shared/i18n.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import type { PluginFactory, ClipboardSource, ClipboardValue, View } from '../../shared/plugin.js';
interface Clip extends ClipboardValue {
  id: string;
  created: number;
  source: string;
}
interface State {
  enabled: boolean;
  paused: boolean;
  excludedApps: string[];
  clips: Clip[];
}
export function pruneClips(clips: Clip[], now = Date.now()): Clip[] {
  let bytes = 0;
  return clips
    .filter((c) => {
      if (c.created <= now - 7 * 86400000) return false;
      const size = Buffer.byteLength(JSON.stringify(c));
      if (bytes + size > 40 * 1024 * 1024) return false;
      bytes += size;
      return true;
    })
    .slice(0, 300);
}
const create: PluginFactory = async (ctx) => {
  const state = await ctx.storage.read<State>({
    enabled: false,
    paused: false,
    excludedApps: [],
    clips: [],
  });
  const prune = () => {
    state.clips = pruneClips(state.clips);
  };
  const save = async () => {
    prune();
    await ctx.storage.write(state);
    ctx.changed();
  };
  let observationError: string | undefined;
  const watch = () => {
    observationError = undefined;
    return ctx.call('clipboard.watch', state.enabled && !state.paused);
  };
  await watch();
  const timer = setInterval(() => void save().catch(() => {}), 60000);
  const view = (): View => {
    prune();
    return {
      title: qt('剪贴板历史'),
      notice:
        observationError ??
        (state.enabled
          ? state.paused
            ? qt('记录已暂停')
            : undefined
          : qt('开启后记录文本和图片，保留 7 天，最多 300 项。密码标记内容不记录。')),
      rows: state.enabled
        ? state.clips.map((c) => ({
            id: c.id,
            name: c.text?.split('\n')[0] || qt('图片'),
            kind: qt('剪贴板'),
            detail: c.text ?? `${c.source} · ${new Date(c.created).toLocaleString()}`,
            image: c.image,
            actions: [
              { id: 'paste', title: qt('粘贴'), data: c.id },
              { id: 'copy', title: qt('复制'), data: c.id },
              { id: 'delete', title: qt('删除'), data: c.id, confirm: qt('删除这条记录？') },
            ],
          }))
        : [],
      actions: state.enabled
        ? [
            { id: 'pause', title: state.paused ? qt('恢复记录') : qt('暂停记录') },
            {
              id: 'exclude',
              title: qt('排除应用'),
              form: {
                title: qt('排除应用'),
                fields: [
                  {
                    id: 'apps',
                    label: qt('应用名称或 bundle ID（每行一个）'),
                    type: 'textarea',
                    maxLength: 25600,
                  },
                ],
                values: { apps: state.excludedApps.join('\n') },
              },
            },
            { id: 'clear', title: qt('清空历史'), confirm: qt('清空全部剪贴板历史？') },
            { id: 'disable', title: qt('关闭记录') },
          ]
        : [{ id: 'enable', title: qt('开启剪贴板历史') }],
    };
  };
  return {
    view,
    resolve: (id) => view().rows.find((row) => row.id === id),
    async run(action, data, values) {
      if (action === 'open') return { navigate: 'main' };
      if (action === 'enable' || action === 'disable' || action === 'pause') {
        if (action === 'pause') state.paused = !state.paused;
        else state.enabled = action === 'enable';
        await watch();
        await save();
        return;
      }
      if (action === 'exclude') {
        state.excludedApps = z
          .array(z.string().max(256))
          .max(100)
          .parse(
            String(values.apps ?? '')
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean),
          );
        await save();
        return;
      }
      if (action === 'clear') {
        const removed = state.clips.map((clip) => clip.id);
        state.clips = [];
        await save();
        return { removed };
      }
      const clip = state.clips.find((c) => c.id === data);
      if (!clip) throw Error(qt('此记录已过期'));
      if (action === 'delete') {
        state.clips = state.clips.filter((c) => c.id !== data);
        await save();
        return { removed: [clip.id] };
      }
      if (action === 'paste') await ctx.call('paste', { text: clip.text, image: clip.image });
      else if (action === 'copy') {
        await ctx.call('clipboard.write', { text: clip.text, image: clip.image });
        await ctx.call('window.hide', undefined);
      } else throw Error(qt('无效操作'));
    },
    async event(name, data) {
      if (name === 'error') {
        observationError = String(data) + qt('，请暂停后恢复记录。');
        ctx.changed();
        return;
      }
      if (name !== 'clipboard' || !state.enabled || state.paused) return;
      const source = data as ClipboardSource;
      if (
        state.excludedApps.some((x) =>
          [source.name.toLowerCase(), source.bundle.toLowerCase()].includes(x.toLowerCase()),
        )
      )
        return;
      const value = await ctx.call('clipboard.read', undefined);
      if (value.sensitive || (!value.text && !value.image) || !state.enabled || state.paused)
        return;
      const id = createHash('sha256')
        .update(value.image ?? value.text ?? '')
        .digest('hex');
      if (state.clips[0]?.id === id) return;
      state.clips = [
        { ...value, id, created: Date.now(), source: source.name },
        ...state.clips.filter((c) => c.id !== id),
      ];
      await save();
    },
    dispose: () => clearInterval(timer),
  };
};
export default create;
